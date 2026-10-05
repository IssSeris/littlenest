import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors());
// Reviewed lists contain up to 200 rows plus the original text. Keep the
// larger, bounded JSON budget specific to private drafts.
app.use("/api/nest/paste-drafts", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "128kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  clerkMiddleware((req) => {
    // The CI preview proxy preserves its own API host for Clerk auth; the
    // separately forwarded browser host is used only by the same-site guard.
    const clerkHost = process.env.PASTE_BROWSER_CI_ROUTER === '1'
      ? req.headers.host
      : getClerkProxyHost(req);
    return {
      publishableKey: publishableKeyFromHost(
        clerkHost ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    };
  }),
);

app.use("/api", router);
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  req.log.error({ err }, "Request failed");
  res.status(500).json({ error: "The request could not be saved. Please try again." });
});

export default app;
