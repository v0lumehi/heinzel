import { z } from "zod";
import type { AgentTool } from "../agent/tools.js";
import type { CodingCoordinator } from "./coordinator.js";

export const CODING_TOOL = "start_coding_task";

type Args = { repository: string; title: string; task: string; base_branch?: string };

/** Prepares a coding session. It only starts once the person confirms with `!go`. */
export function createCodingTool(coding: CodingCoordinator): AgentTool<Args> {
  return {
    name: CODING_TOOL,
    description:
      "Hand a coding task to the coding agent: it works on a repository in an isolated environment, runs the tests and opens a " +
      "draft merge request. Use it when someone asks you to implement, fix or change code. The agent sees this conversation, " +
      "but write the task so it stands on its own: goal, relevant files or behaviour, acceptance criteria. " +
      "The session waits for the person's confirmation (`!go`) before anything runs.",
    directOnly: true,
    args: z.object({
      repository: z.string().min(3).max(200),
      title: z.string().min(3).max(100),
      task: z.string().min(10).max(20_000),
      base_branch: z.string().max(200).optional(),
    }),
    parameters: {
      type: "object",
      properties: {
        repository: { type: "string", description: 'Project path on the git host, e.g. "platform/billing-api".' },
        title: { type: "string", description: "Short imperative title, used for the branch and merge request (e.g. \"Fix login redirect\")." },
        task: { type: "string", description: "Complete task description for the coding agent." },
        base_branch: { type: "string", description: "Branch to start from. Default: the repository's default branch." },
      },
      required: ["repository", "title", "task"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.userKey) return "A coding session needs a person to confirm it; none is in this conversation.";
      return coding.prepare({
        channelKey: ctx.channelKey,
        threadRef: ctx.threadRef,
        userKey: ctx.userKey,
        eventId: ctx.eventId,
        repository: args.repository,
        title: args.title,
        task: args.task,
        baseBranch: args.base_branch,
      });
    },
  };
}
