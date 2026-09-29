import { ApiError } from "../utils/errors.js";

export class WebsiteDownloadError extends ApiError {
  constructor(code: string, message: string, status = 422, details?: unknown) {
    super(status, code, message, details);
    this.name = "WebsiteDownloadError";
  }
}
