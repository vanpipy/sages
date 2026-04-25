import { FilesystemBackend } from "deepagents";

export const sagesBackend = new FilesystemBackend({
  rootDir: ".sages",
});