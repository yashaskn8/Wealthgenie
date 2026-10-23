"""Independent Python Decimal reference for GenieDecision loan calculations.
Uses closed-form annuity estimate, then independently tests cent-level repayment.
Does not import or call WealthGenie's JavaScript debt engine.
"""
import json
import sys
from decimal import Decimal, ROUND_HALF_UP, ROUND_CEILING, localcontext

def reference(source):
    principal = int(source["principalPaise"])
    annual_bps = int(source["aprBps"])
    months = int(source["termMonths"])
    horizon = int(source["horizonMonths"])
    assert 0 <= principal <= 10**12 and 0 <= annual_bps <= 5000
    assert 1 <= months <= 360 and 1 <= horizon <= 360

    def rounded_interest(balance):
        with localcontext() as ctx:
            ctx.prec = 64
            return int((Decimal(balance) * Decimal(annual_bps) / Decimal(120000))
                       .quantize(Decimal("1"), rounding=ROUND_HALF_UP))

    def repay(payment):
        outstanding = principal
        interest_sum = 0
        payments = []
        for _ in range(horizon):
            if not outstanding:
                payments.append(0)
                continue
            interest = rounded_interest(outstanding)
            due = outstanding + interest
            actual = min(payment, due)
            outstanding = due - actual
            interest_sum += interest
            payments.append(actual)
        return outstanding, interest_sum, payments

    if principal == 0:
        guess = 0
    elif annual_bps == 0:
        guess = (principal + months - 1) // months
    else:
        with localcontext() as ctx:
            ctx.prec = 64
            rate = Decimal(annual_bps) / Decimal(120000)
            growth = (Decimal(1) + rate) ** months
            annuity = Decimal(principal) * rate * growth / (growth - 1)
            guess = int(annuity.to_integral_value(rounding=ROUND_CEILING))

    while repay(guess)[0] != 0:
        guess += 1
    while guess > 0 and repay(guess - 1)[0] == 0:
        guess -= 1
    balance, interest, payments = repay(guess)
    return {"monthlyPaymentPaise": guess, "remainingPaise": balance,
            "interestPaise": interest, "paymentsPaise": payments}

if __name__ == "__main__":
    print(json.dumps(reference(json.load(sys.stdin))))
