export class SandCloudAgentLaunchError extends Error {
  override readonly name: string = "SandCloudAgentLaunchError";
}

/** Stable policy refusal that the HTTP boundary can map to 403. */
export class SandCloudAgentDisabledError extends SandCloudAgentLaunchError {
  override readonly name: string = "SandCloudAgentDisabledError";

  constructor(message = "Cloud Agents are disabled by your team administrator.") {
    super(message);
  }
}
