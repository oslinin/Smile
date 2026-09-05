#!/usr/bin/env python3
"""Smile volatility-surface renderer.

A tiny Flask service that draws the protocol's multiparameter vol surface as a
3-D matplotlib plot and mutates it as trades are executed — the same feedback
loop the on-chain hook applies (``OptionPricingHook.bumpSigma``):

    sigma_strike(K, T) = sigma_tenor(T) * max(0.1, 1 + alpha*ln(K/S)^2 + beta*ln(K/S))

State lives here so the surface truly *evolves*: every ``buy`` bumps the traded
tenor bucket by +gamma, every ``close``/sellback decays it by -gamma. The
frontend notifies this service on each confirmed trade and re-fetches the PNG.

Endpoints
---------
GET  /state          -> current surface parameters (JSON)
POST /trade          -> {dte, direction:"buy"|"sell"} bump/decay a tenor bucket
POST /reset          -> restore default term structure
GET  /surface.png    -> render the current surface (query: spot, alpha, beta, elev, azim)
GET  /health         -> liveness probe

Run:  ./run.sh   (creates a venv, installs deps, serves on :8000)
"""

from __future__ import annotations

import io
import math
import os
import threading

import matplotlib

matplotlib.use("Agg")  # headless — render straight to PNG bytes

import matplotlib.pyplot as plt
import numpy as np
from flask import Flask, jsonify, request, send_file

# ── Surface model (mirrors SmileMath.sol / OptionPricingHook) ────────────────

# Tenor buckets in days: [0,7), [7,30), [30,90), [90,inf) — the term structure.
TENOR_EDGES = [0, 7, 30, 90, float("inf")]
TENOR_LABELS = ["0-7d", "7-30d", "30-90d", "90d+"]

# Demand-driven IV per bucket. Defaults encode a mild term structure (short-dated
# richer), matching the crypto-vol shape the README describes.
DEFAULT_SIGMA_TENOR = [0.95, 0.85, 0.80, 0.72]

ALPHA = 2.0   # smile curvature
BETA = 0.0    # skew tilt (negative = put skew)
GAMMA = 0.005  # sigma feedback per trade (0.5%)

# σ is floored/capped so the wings can't collapse or explode.
SIGMA_FLOOR = 0.05
SIGMA_CAP = 3.0

_lock = threading.Lock()
_state = {
    "sigma_tenor": list(DEFAULT_SIGMA_TENOR),
    "alpha": ALPHA,
    "beta": BETA,
    "trades": 0,  # bumps the cache-buster / lets the UI show activity
}


def _bucket_for_dte(dte: float) -> int:
    """Index of the tenor bucket a given days-to-expiry falls into."""
    for i in range(len(TENOR_EDGES) - 1):
        if TENOR_EDGES[i] <= dte < TENOR_EDGES[i + 1]:
            return i
    return len(TENOR_LABELS) - 1


def _sigma_tenor_for_dte(dte: float, sigma_tenor: list[float]) -> float:
    return sigma_tenor[_bucket_for_dte(dte)]


def _smile_multiplier(moneyness: np.ndarray, alpha: float, beta: float) -> np.ndarray:
    """max(0.1, 1 + alpha*ln(K/S)^2 + beta*ln(K/S)) — the smile in strike space."""
    ln = np.log(moneyness)
    return np.maximum(0.1, 1.0 + alpha * ln * ln + beta * ln)


# ── Rendering ────────────────────────────────────────────────────────────────

# Dark palette matching the frontend (bg gray-950).
_BG = "#030712"
_PANEL = "#0b1120"
_GRID = "#1f2937"
_TEXT = "#e5e7eb"
_MUTED = "#9ca3af"


def render_surface(spot: float, alpha: float, beta: float, elev: float, azim: float) -> bytes:
    with _lock:
        sigma_tenor = list(_state["sigma_tenor"])
        trades = _state["trades"]

    # Strike grid as moneyness K/S in [0.6, 1.4]; DTE grid 1..180 days.
    moneyness = np.linspace(0.6, 1.4, 60)
    dtes = np.linspace(1, 180, 60)
    strikes = moneyness * spot

    smile = _smile_multiplier(moneyness, alpha, beta)  # (60,) over strike
    tenor = np.array([_sigma_tenor_for_dte(d, sigma_tenor) for d in dtes])  # (60,) over DTE

    K, T = np.meshgrid(strikes, dtes)
    # sigma_strike(K,T) = sigma_tenor(T) * smile(K/S), as a percentage.
    Z = (tenor[:, None] * smile[None, :]) * 100.0
    Z = np.clip(Z, SIGMA_FLOOR * 100, SIGMA_CAP * 100)

    fig = plt.figure(figsize=(8.2, 6.0), dpi=110)
    fig.patch.set_facecolor(_BG)
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor(_BG)

    surf = ax.plot_surface(
        K, T, Z,
        cmap="plasma",
        linewidth=0.15,
        edgecolor=_GRID,
        antialiased=True,
        rstride=1,
        cstride=1,
        alpha=0.96,
    )

    # ATM ridge (K = spot) — the term structure of at-the-money vol.
    atm_sigma = np.array([_sigma_tenor_for_dte(d, sigma_tenor) for d in dtes]) * 100.0
    ax.plot(
        np.full_like(dtes, spot), dtes, atm_sigma,
        color="#22d3ee", linewidth=2.4, label="ATM term structure",
    )

    ax.set_xlabel("Strike K ($)", color=_TEXT, labelpad=10, fontsize=9)
    ax.set_ylabel("Days to expiry", color=_TEXT, labelpad=10, fontsize=9)
    ax.set_zlabel("Implied vol σ (%)", color=_TEXT, labelpad=8, fontsize=9)

    for pane_axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        pane_axis.set_pane_color((0.02, 0.03, 0.06, 1.0))
        pane_axis._axinfo["grid"]["color"] = (0.12, 0.16, 0.22, 1.0)
    ax.tick_params(colors=_MUTED, labelsize=7)

    buckets = "  ".join(
        f"{lbl} {s * 100:.1f}%" for lbl, s in zip(TENOR_LABELS, sigma_tenor)
    )
    ax.set_title(
        f"Smile vol surface   ·   spot ${spot:,.0f}   ·   α={alpha:g} β={beta:g}\n"
        f"σ tenor:  {buckets}   ·   {trades} trades",
        color=_TEXT, fontsize=9.5, pad=14,
    )

    ax.view_init(elev=elev, azim=azim)
    ax.legend(loc="upper left", fontsize=7, facecolor=_PANEL,
              edgecolor=_GRID, labelcolor=_TEXT)

    cbar = fig.colorbar(surf, ax=ax, shrink=0.55, aspect=14, pad=0.08)
    cbar.set_label("σ (%)", color=_MUTED, fontsize=8)
    cbar.ax.yaxis.set_tick_params(color=_MUTED, labelsize=7)
    plt.setp(plt.getp(cbar.ax.axes, "yticklabels"), color=_MUTED)

    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=_BG, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


# ── HTTP app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)


@app.after_request
def _cors(resp):
    # The Next.js frontend (localhost:3000) fetches from here (localhost:8000).
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/health")
def health():
    return jsonify(ok=True)


@app.route("/state")
def state():
    with _lock:
        return jsonify(
            sigma_tenor=_state["sigma_tenor"],
            tenor_labels=TENOR_LABELS,
            alpha=_state["alpha"],
            beta=_state["beta"],
            gamma=GAMMA,
            trades=_state["trades"],
        )


@app.route("/trade", methods=["POST", "OPTIONS"])
def trade():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    dte = float(body.get("dte", 30))
    direction = str(body.get("direction", "buy")).lower()
    step = float(body.get("gamma", GAMMA))
    sign = 1.0 if direction == "buy" else -1.0  # buy steepens, sellback decays
    idx = _bucket_for_dte(dte)
    with _lock:
        cur = _state["sigma_tenor"][idx]
        _state["sigma_tenor"][idx] = float(
            min(SIGMA_CAP, max(SIGMA_FLOOR, cur + sign * step))
        )
        _state["trades"] += 1
        snapshot = list(_state["sigma_tenor"])
        trades = _state["trades"]
    return jsonify(
        ok=True, bucket=TENOR_LABELS[idx], sigma_tenor=snapshot, trades=trades
    )


@app.route("/reset", methods=["POST", "OPTIONS"])
def reset():
    if request.method == "OPTIONS":
        return ("", 204)
    with _lock:
        _state["sigma_tenor"] = list(DEFAULT_SIGMA_TENOR)
        _state["alpha"] = ALPHA
        _state["beta"] = BETA
        _state["trades"] = 0
    return jsonify(ok=True)


@app.route("/surface.png")
def surface_png():
    spot = float(request.args.get("spot", 3420))
    alpha = float(request.args.get("alpha", _state["alpha"]))
    beta = float(request.args.get("beta", _state["beta"]))
    elev = float(request.args.get("elev", 26))
    azim = float(request.args.get("azim", -58))
    with _lock:
        _state["alpha"] = alpha
        _state["beta"] = beta
    png = render_surface(spot, alpha, beta, elev, azim)
    return send_file(io.BytesIO(png), mimetype="image/png")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Smile vol-surface renderer on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, threaded=True)
