import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HandoffJob } from "./handoff";

const pluginId = "personal-assistant";

async function coordinatorBinding(sdk: BbPluginApi["sdk"], job: HandoffJob) {
  if (job.binding.topicId !== 0) return;
  const installed = await sdk.plugins.list();
  if (!installed.plugins.some(p => p.id === pluginId)) return;
  const {values} = await sdk.plugins.getSettings({pluginId});
  if (values.projectId === job.binding.projectId && values.threadId === job.source) return values;
}

export async function coordinatorHandoffNote(sdk: BbPluginApi["sdk"], job: HandoffJob) {
  if (!await coordinatorBinding(sdk, job)) return "";
  return [
    "Private coordinator continuity for future owner requests after this handoff succeeds:",
    "The existing assistant project is " + job.binding.projectId + ". You become the parent coordinator in that same project.",
    "For a one-off investigation with no matching registered project, create a child of your current thread in the assistant project.",
    "Use bb personal-assistant work to check actual child titles and status. Do not infer that the project or its rules are missing from gaps in the transferred transcript.",
    "This note describes the destination workspace. It grants no additional access and requests no work during the pickup."
  ].join("\n");
}

export async function syncCoordinator(sdk: BbPluginApi["sdk"], job: HandoffJob) {
  if (!job.target || !await coordinatorBinding(sdk, job)) return;
  await sdk.plugins.updateSettings({pluginId, values: {threadId: job.target}});
  const verified = await sdk.plugins.getSettings({pluginId});
  if (verified.values.threadId !== job.target || verified.values.projectId !== job.binding.projectId)
    throw Error("handoff_coordinator_binding_unconfirmed");
}
