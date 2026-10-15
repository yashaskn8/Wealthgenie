import pytest
import asyncio
from unittest.mock import MagicMock, patch
import pandas as pd
from model.registry.drift_monitor import InferenceBuffer
from model.registry.drift_scheduler import DriftScheduler


@pytest.mark.asyncio
async def test_drift_scheduler_tick_skips_on_insufficient_samples():
    scheduler = DriftScheduler()
    scheduler._interval_seconds = 1
    scheduler._min_samples = 100
    mock_store = MagicMock()

    with patch("model.registry.drift_monitor.inference_buffer.size", return_value=5):
        scheduler.start(mock_store)
        await asyncio.sleep(1.2)
        assert scheduler.tick_count >= 1
        await scheduler.stop()
        assert not scheduler.is_running


@pytest.mark.asyncio
async def test_drift_scheduler_triggers_check_on_sufficient_samples():
    scheduler = DriftScheduler()
    scheduler._interval_seconds = 1
    scheduler._min_samples = 100
    mock_store = MagicMock()

    evaluation_frame = pd.DataFrame({"feature": range(150)})
    with patch("model.registry.drift_monitor.inference_buffer.size", return_value=150), \
         patch("model.registry.drift_monitor.inference_buffer.get_dataframe", return_value=evaluation_frame), \
         patch("model.registry.drift_monitor.inference_buffer.discard_oldest") as mock_discard, \
         patch("model.registry.drift_monitor.check_drift_and_trigger_retrain", return_value={
             "status": "COMPLETED",
             "overall_verdict": "FAIL",
             "max_psi": 2.5,
             "drift_detected": True,
             "retrain_triggered": True,
             "candidate_version": {"version_id": "test-candidate-123"}
         }) as mock_drift_check:
        scheduler.start(mock_store)
        await asyncio.sleep(1.2)
        assert scheduler.tick_count >= 1
        await scheduler.stop()
        mock_drift_check.assert_called()
        call_kwargs = mock_drift_check.call_args[1]
        assert call_kwargs.get("registered_by") == "drift_scheduler"
        assert call_kwargs.get("input_df") is evaluation_frame
        assert call_kwargs.get("force_retrain_on_drift") is False
        mock_discard.assert_called_once_with(150)


def test_drift_scheduler_uses_statistically_meaningful_default_window(monkeypatch):
    monkeypatch.delenv("DRIFT_CHECK_INTERVAL_SECONDS", raising=False)
    monkeypatch.delenv("DRIFT_CHECK_MIN_SAMPLES", raising=False)
    scheduler = DriftScheduler()
    assert scheduler._min_samples == 200


def test_inference_buffer_discards_only_evaluated_prefix():
    buffer = InferenceBuffer(capacity=10)
    buffer.record_batch([{"sample": 1}, {"sample": 2}, {"sample": 3}])
    evaluated = buffer.get_dataframe()
    buffer.record({"sample": 4})

    assert buffer.discard_oldest(len(evaluated)) == 3
    assert buffer.get_dataframe().to_dict("records") == [{"sample": 4}]


@pytest.mark.parametrize("environment", ["production", "prod"])
@pytest.mark.parametrize("value", ["0", "10", "99", "-1"])
def test_drift_scheduler_rejects_undersized_production_windows(monkeypatch, environment, value):
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("DRIFT_CHECK_MIN_SAMPLES", value)
    expected = "positive integer" if int(value) <= 0 else "at least 100 in production"
    with pytest.raises(ValueError, match=expected):
        DriftScheduler()
