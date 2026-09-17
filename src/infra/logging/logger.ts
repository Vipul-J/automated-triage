import { pino } from "pino";
import { config } from "../../config/index.js";

const isDev = config.env === "development";

export const logger = pino({
  level: config.logLevel,
  base: undefined, // drop pid/hostname noise in a single-node skeleton
  redact: {
    paths: ["req.headers.authorization", "req.headers['x-signature']", "*.apiKey", "*.password"],
    censor: "[redacted]",
  },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }
    : {}),
});

/** Child logger bound to a component name, so every line is attributable. */
export const loggerFor = (component: string) => logger.child({ component });
