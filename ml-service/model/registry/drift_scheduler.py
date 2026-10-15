"""
WealthGenie ML Microservice — Scheduled Drift Diagnostics
Runs check_drift_and_trigger_retrain() in diagnostics-only mode on a configurable interval
using an asyncio periodic task inside the FastAPI event loop.

Every tick is logged — including skips due to insufficient buffer samples —
so the full timeline of scheduler activity is visible in production logs.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from environment_policy import configured_environment_mode

logger = logging.getLogger("wealthgenie.drift_scheduler")


class DriftScheduler:
    """
    Asyncio-based periodic drift checker.

    Scheduled runs are diagnostic only. Candidate training remains an explicit
    operator/offline action and is never triggered by this background loop.

    Configuration (via environment variables):
        DRIFT_CHECK_INTERVAL_SECONDS: Seconds between checks (default: 300)
        DRIFT_CHECK_MIN_SAMPLES: Minimum buffer size to run a check (default: 200)
    """

    REGISTERED_BY_TAG = "drift_scheduler"

    def __init__(self):
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._store: Any = None
        self._tick_count = 0
        self._interval_seconds: int = int(
            os.environ.get("DRIFT_CHECK_INTERVAL_SECONDS", "300")
        )
        self._min_samples: int = int(
            os.environ.get("DRIFT_CHECK_MIN_SAMPLES", "200")
        )
        if self._interval_seconds <= 0:
            raise ValueError("DRIFT_CHECK_INTERVAL_SECONDS must be a positive integer")
        environment = configured_environment_mode(os.environ)
        if self._min_samples <= 0:
            raise ValueError("DRIFT_CHECK_MIN_SAMPLES must be a positive integer")
        if environment == "production" and self._min_samples < 100:
            raise ValueError("DRIFT_CHECK_MIN_SAMPLES must be at least 100 in production")

    def start(self, version_registry: Any) -> None:
        """Start the periodic drift check background task."""
        if self._running:
            logger.warning("[DriftScheduler] Already running — ignoring duplicate start().")
            return

        self._store = version_registry
        self._running = True
        self._tick_count = 0
        self._task = asyncio.get_event_loop().create_task(self._loop())
        logger.info(
            f"[DriftScheduler] Started. interval={self._interval_seconds}s, "
            f"min_samples={self._min_samples}"
        )

    async def stop(self) -> None:
        """Gracefully stop the periodic drift check."""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("[DriftScheduler] Stopped.")

    async def _loop(self) -> None:
        """Main periodic loop — sleeps for the configured interval, then runs a check."""
        while self._running:
            try:
                await asyncio.sleep(self._interval_seconds)
            except asyncio.CancelledError:
                break

            if not self._running:
                break

            self._tick_count += 1
            tick_time = datetime.now(timezone.utc).isoformat()

            # Import here to avoid circular imports at module load time
            from model.registry.drift_monitor import inference_buffer

            buffer_size = inference_buffer.size()
            logger.info(
                f"[DriftScheduler] Tick #{self._tick_count} at {tick_time} — "
                f"buffer_size={buffer_size}, min_required={self._min_samples}"
            )

            if buffer_size < self._min_samples:
                logger.info(
                    f"[DriftScheduler] Tick #{self._tick_count} SKIPPED — "
                    f"insufficient samples ({buffer_size} < {self._min_samples})"
                )
                continue

            evaluated_frame = inference_buffer.get_dataframe()
            if evaluated_frame is None or len(evaluated_frame) < self._min_samples:
                logger.info(
                    f"[DriftScheduler] Tick #{self._tick_count} SKIPPED — "
                    "the atomic evaluation snapshot was below the configured minimum"
                )
                continue
            evaluated_sample_count = len(evaluated_frame)

            # Run the drift check in a thread to avoid blocking the event loop
            # (PSI computation + retrain are CPU-bound synchronous code)
            try:
                result = await asyncio.to_thread(self._run_drift_check, evaluated_frame)
                status = result.get("status", "UNKNOWN")
                drift_detected = result.get("drift_detected", False)
                retrain_triggered = result.get("retrain_triggered", False)
                verdict = result.get("overall_verdict", "N/A")
                max_psi = result.get("max_psi", 0.0)

                # Each buffered observation belongs to exactly one scheduled
                # evaluation window. Discard only the snapshotted prefix so
                # observations recorded while evaluation was running survive.
                if status == "COMPLETED":
                    inference_buffer.discard_oldest(evaluated_sample_count)

                logger.info(
                    f"[DriftScheduler] Tick #{self._tick_count} COMPLETED — "
                    f"status={status}, verdict={verdict}, max_psi={max_psi}, "
                    f"drift_detected={drift_detected}, retrain_triggered={retrain_triggered}"
                )

                if retrain_triggered:
                    candidate = result.get("candidate_version", {})
                    logger.info(
                        f"[DriftScheduler] Tick #{self._tick_count} — Candidate registered: "
                        f"version_id={candidate.get('version_id')}, "
                        f"registered_by={self.REGISTERED_BY_TAG}"
                    )

            except Exception as e:
                logger.error(
                    f"[DriftScheduler] Tick #{self._tick_count} FAILED — {type(e).__name__}: {e}",
                    exc_info=True,
                )

    def _run_drift_check(self, input_df=None) -> dict:
        """
        Synchronous wrapper calling the existing drift check logic.
        Passes registered_by tag so the registry record is provably scheduler-triggered.
        """
        from model.registry.drift_monitor import check_drift_and_trigger_retrain

        return check_drift_and_trigger_retrain(
            architecture="RandomForest",
            input_df=input_df,
            store=self._store,
            force_retrain_on_drift=False,
            registered_by=self.REGISTERED_BY_TAG,
        )

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def tick_count(self) -> int:
        return self._tick_count

    @property
    def interval_seconds(self) -> int:
        return self._interval_seconds


# Singleton instance
drift_scheduler = DriftScheduler()
