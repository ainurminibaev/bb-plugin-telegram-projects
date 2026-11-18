import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HandoffJob } from "./handoff";

export async function syncCoordinator(sdk: BbPluginApi["sdk"], job: HandoffJob) {
  if (job.binding.topicId !== 0) return;
  const pluginId = "personal-assistant";
  const installed = await sdk.plugins.list();
  if (!installed.plugins.some(p => p.id === pluginId)) return;
  const {values} = await sdk.plugins.getSettings({pluginId});
  if (!job.target || values.projectId !== job.binding.projectId || values.threadId !== job.source) return;
  await sdk.plugins.updateSettings({pluginId, values: {threadId: job.target}});
  const verified = await sdk.plugins.getSettings({pluginId});
  if (verified.values.threadId !== job.target || verified.values.projectId !== job.binding.projectId)
    throw Error("handoff_coordinator_binding_unconfirmed");
}
