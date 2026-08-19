// Mock x402 paid endpoint (PHASE2.md: "use its seller middleware for the
// mock paid endpoint"). A minimal Express server with one route behind a
// $0.01 USDC paywall on Base Sepolia, using @x402/express — the current
// (v2) x402 package; see README.md for why not the deprecated v1
// (`x402-express`).
//
// This only needs a receiving address to construct valid payment
// requirements — it never needs funds itself. Building the app does one
// unauthenticated, read-only call to the facilitator's /supported
// endpoint (`resourceServer.initialize()`) to learn which payment kinds
// it accepts; that's metadata discovery, not a fund-moving action, and
// x402ResourceServer requires it before it can build payment requirements
// for a route at all.
import { pathToFileURL } from "node:url";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

export const DEFAULT_PORT = Number(process.env.MOCK_SELLER_PORT ?? 4021);
export const DEFAULT_PAY_TO = (process.env.X402_PAY_TO ??
  "0x000000000000000000000000000000000000dEaD") as `0x${string}`;
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";

export async function createSellerApp() {
  const app = express();
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    "eip155:84532", // Base Sepolia
    new ExactEvmScheme()
  );
  await resourceServer.initialize();

  app.use(
    paymentMiddleware(
      {
        "GET /treasury-report": {
          accepts: {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:84532",
            payTo: DEFAULT_PAY_TO,
          },
          description: "Agent Treasury demo: a paid treasury report endpoint",
        },
      },
      resourceServer,
      undefined,
      undefined,
      /* syncFacilitatorOnStart */ false // already initialized above
    )
  );

  app.get("/treasury-report", (_req, res) => {
    res.json({ report: "all entitlements nominal", generated_at: new Date().toISOString() });
  });

  return app;
}

export async function startSeller(port = DEFAULT_PORT) {
  const app = await createSellerApp();
  return app.listen(port);
}

// `tsx mock/seller.ts` runs it standalone; scripts/demo.ts imports
// startSeller() directly instead. Compared as a proper file:// URL, not a
// string-concatenated path — `process.argv[1]` is a bare Windows path
// (`C:\...`), which isn't one.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startSeller();
  server.on("listening", () => {
    console.log(`mock x402 seller listening on http://localhost:${DEFAULT_PORT}/treasury-report`);
  });
}
