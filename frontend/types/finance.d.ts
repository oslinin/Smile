// Type declarations for the MIT-licensed pricing libraries
// (https://github.com/MattL922/black-scholes, https://github.com/MattL922/greeks)

declare module "black-scholes" {
  /** European option price. t in years, v annualized vol, r risk-free rate. */
  export function blackScholes(
    s: number,
    k: number,
    t: number,
    v: number,
    r: number,
    callPut: "call" | "put"
  ): number;
}

declare module "greeks" {
  export function getDelta(s: number, k: number, t: number, v: number, r: number, callPut: "call" | "put"): number;
  export function getGamma(s: number, k: number, t: number, v: number, r: number): number;
  /** Per-day theta by default (scale = 365). */
  export function getTheta(s: number, k: number, t: number, v: number, r: number, callPut: "call" | "put", scale?: number): number;
  /** Per 1% change in IV. */
  export function getVega(s: number, k: number, t: number, v: number, r: number): number;
  export function getRho(s: number, k: number, t: number, v: number, r: number, callPut: "call" | "put", scale?: number): number;
}
