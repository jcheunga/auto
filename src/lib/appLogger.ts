import { config } from "../config";
import { createLogger } from "./logger";

export const appLogger = createLogger({
  level: config.logLevel,
  bindings: {
    service: "monday-automation"
  }
});
