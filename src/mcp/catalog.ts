/**
 * Prepared integrations for the admin UI: an admin fills in a few fields (URL, token) instead of raw MCP settings.
 * Adding an integration = adding an entry here. `verified` means it was tested against the real service.
 */

export interface CatalogField {
  key: string;
  label: string;
  help: string;
  /** Stored encrypted and never shown again. */
  secret: boolean;
  placeholder?: string;
  default?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Tested end to end against the real service. */
  verified: boolean;
  /** Suggested server name, which becomes the tool prefix (name__tool). */
  defaultName: string;
  docsUrl: string;
  /** Shown when the integration needs something outside the admin UI. */
  requires?: string;
  fields: CatalogField[];
  /** Only these tools by default (null = all). */
  tools: string[] | null;
  /** Tools hidden by default. */
  exclude: string[];
  build(values: Record<string, string>): { url: string; headers: Record<string, string> };
}

const DOCS = "https://github.com/v0lumehi/heinzel/blob/main/docs/TOOLS.md";

export const CATALOG: CatalogEntry[] = [
  {
    id: "searxng",
    name: "Web search (SearXNG)",
    description: "Searches the web through your own SearXNG instance. No accounts or API keys, nothing leaves your infrastructure except the search itself.",
    verified: true,
    defaultName: "search",
    docsUrl: `${DOCS}#web-search-searxng-self-hosted`,
    requires: "The SearXNG and mcp-searxng containers from the deployment (docker compose --profile tools, or your own).",
    fields: [
      {
        key: "url",
        label: "MCP endpoint",
        help: "Address of the mcp-searxng container as Heinzel reaches it.",
        secret: false,
        default: "http://mcp-searxng:3000/mcp",
        placeholder: "http://mcp-searxng:3000/mcp",
      },
    ],
    tools: ["searxng_web_search"],
    exclude: [],
    build: (v) => ({ url: v.url!.trim(), headers: {} }),
  },
  {
    id: "gitlab",
    name: "GitLab",
    description:
      "Reads projects, files, issues, merge requests, commits and pipelines, and can open issues and comment. Merging, approvals and pipeline control stay off: code changes go through coding sessions.",
    verified: false,
    defaultName: "gitlab",
    docsUrl: `${DOCS}#gitlab-official-mcp-server`,
    fields: [
      { key: "gitlabUrl", label: "GitLab URL", help: "Your GitLab instance, e.g. https://gitlab.example.com or https://gitlab.com.", secret: false, placeholder: "https://gitlab.example.com" },
      {
        key: "token",
        label: "Access token",
        help: "A fine-grained personal access token with the permission “MCP tool: Execute”, ideally of a dedicated bot user. Project and group tokens do not work here.",
        secret: true,
        placeholder: "glpat-…",
      },
    ],
    tools: [
      "search", "get_project", "list_projects", "get_repository_file", "list_repository_tree",
      "get_issue", "create_issue", "get_work_item", "list_work_items", "get_workitem_notes",
      "list_merge_requests", "get_merge_request", "get_merge_request_diffs", "get_merge_request_notes",
      "list_commits", "get_commit", "list_pipelines", "get_pipeline", "get_pipeline_jobs", "save_note",
    ],
    exclude: [],
    build: (v) => ({ url: `${v.gitlabUrl!.trim().replace(/\/+$/, "")}/api/v4/mcp`, headers: { Authorization: `Bearer ${v.token!.trim()}` } }),
  },
  {
    id: "atlassian",
    name: "Jira and Confluence",
    description: "Searches and reads Jira issues and Confluence pages through Atlassian's Rovo MCP server (Atlassian Cloud). Creating and changing content is off by default.",
    verified: false,
    defaultName: "jira",
    docsUrl: `${DOCS}#jira-and-confluence-atlassian-rovo-mcp-server`,
    requires: "An Atlassian organization admin must allow API token authentication for the Rovo MCP server.",
    fields: [
      { key: "email", label: "Account email", help: "The Atlassian account Heinzel acts as, ideally a dedicated one.", secret: false, placeholder: "heinzel@example.com" },
      { key: "apiToken", label: "API token", help: "Created at id.atlassian.com under Security → API tokens.", secret: true },
    ],
    tools: null,
    exclude: ["create*", "edit*", "update*", "add*", "transition*", "delete*"],
    build: (v) => ({
      url: "https://mcp.atlassian.com/v1/mcp",
      headers: { Authorization: `Basic ${Buffer.from(`${v.email!.trim()}:${v.apiToken!.trim()}`).toString("base64")}` },
    }),
  },
];

/** Checks that all fields are filled (falling back to defaults) and builds the connection settings. */
export function buildCatalogServer(entry: CatalogEntry, values: Record<string, string>): { url: string; headers: Record<string, string> } {
  const filled: Record<string, string> = {};
  for (const f of entry.fields) {
    const v = (values[f.key] ?? "").trim() || f.default || "";
    if (!v) throw new Error(`${f.label} is missing`);
    filled[f.key] = v;
  }
  return entry.build(filled);
}
