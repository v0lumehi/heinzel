/** Plain-language descriptions of the built-in agent tools, for the admin UI. The model sees its own, more technical descriptions. */
export interface BuiltinToolInfo {
  name: string;
  title: string;
  what: string;
  how: string;
}

export const BUILTIN_TOOLS: BuiltinToolInfo[] = [
  {
    name: "remember",
    title: "Remember",
    what: "Saves a fact for later: a decision, who owns what, a team convention or a personal preference.",
    how: "Stored in your database for this channel, the whole organization or one person. People can list memories with !memories, and admins can search and delete them on the Memories page.",
  },
  {
    name: "recall",
    title: "Recall",
    what: "Looks up what the team told Heinzel before, when an answer depends on earlier context.",
    how: "Full-text search over the memories that apply to the current channel, the organization and the person asking. Heinzel also gets the most relevant memories automatically with every question.",
  },
  {
    name: "forget",
    title: "Forget",
    what: "Deletes a memory when someone says it is wrong or outdated.",
    how: "Only memories visible in the current conversation can be deleted. Admins can delete any memory on the Memories page, and every deletion there is recorded in the audit log.",
  },
  {
    name: "schedule_followup",
    title: "Follow-up",
    what: "Checks back later in a thread, for example when someone promised to fix something by tomorrow.",
    how: "Creates a job that runs at the chosen time. Heinzel then reads the thread again and only posts if it is still useful. Unprompted posts count against the channel's daily limit.",
  },
  {
    name: "web__fetch_url",
    title: "Read web pages",
    what: "Opens a link from the conversation or a search result and reads the page as text.",
    how: "Only public addresses: private and internal networks are always refused, so it cannot be used to reach systems inside your network. Long pages are cut, and page content is treated as information, never as instructions.",
  },
  {
    name: "escalate",
    title: "Hand over to the strong model",
    what: "Passes a hard question to the heavy model when the regular model is not up to it.",
    how: "Only offered when a heavy model is configured, and limited by the daily number of heavy runs per channel. People can also ask for it directly with !deep.",
  },
  {
    name: "start_coding_task",
    title: "Coding session",
    what: "Hands a code change to a coding agent, which works in an isolated container and opens a draft merge request.",
    how: "Only offered when someone talks to Heinzel directly, and nothing runs until that person confirms with !go. The container reaches only the allowed hosts, and its changes leave only as a draft for review.",
  },
];
