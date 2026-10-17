import { ActionIcon, Alert, Anchor, Badge, Button, Checkbox, Group, Modal, NumberInput, Paper, SimpleGrid, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconEyeOff, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CatalogEntryRow, type ConfigResponse, type McpServerInputBody, type McpServerRow, type McpTestResponse, type SettingsResponse, type ToolsResponse } from "../api";
import { Loaded, PageHeader, SectionTitle } from "../components";
import { SecretsKeyHint } from "./Settings";

export function ToolsPage({ canEdit }: { canEdit: boolean }) {
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api<ToolsResponse>("/api/tools") });
  const servers = useQuery({ queryKey: ["mcp"], queryFn: () => api<McpServerRow[]>("/api/mcp") });
  const catalog = useQuery({ queryKey: ["mcp-catalog"], queryFn: () => api<CatalogEntryRow[]>("/api/mcp/catalog") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/api/settings") });
  const config = useQuery({ queryKey: ["config"], queryFn: () => api<ConfigResponse>("/api/config") });
  const [editing, setEditing] = useState<McpServerRow | "new" | null>(null);
  const [connecting, setConnecting] = useState<CatalogEntryRow | null>(null);
  const names = new Set((servers.data ?? []).map((s) => s.name));
  return (
    <>
      <PageHeader title="Tools" />
      {settings.data && (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} mb="lg">
          <Model label="Agent model" value={settings.data.models.agent} />
          <Model label="Triage model" value={settings.data.models.triage} />
          <Model label="Heavy model" value={settings.data.models.heavy} />
          <Model label="Coding model" value={settings.data.models.coding} />
        </SimpleGrid>
      )}

      <SectionTitle>Built-in tools</SectionTitle>
      <Text size="sm" c="dimmed" mb="sm" maw={760}>
        Heinzel decides on its own when to use a tool, based on the conversation. These tools are part of Heinzel and need no setup.
      </Text>
      <Loaded query={tools}>
        {(t) => (
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {t.builtin.map((b) => (
              <Paper withBorder p="md" key={b.name} style={b.enabled ? undefined : { opacity: 0.6 }}>
                <Group justify="space-between" mb={4} wrap="nowrap">
                  <Text fw={600}>{b.title}</Text>
                  <Badge variant="light" color={b.enabled ? "green" : "gray"}>{b.enabled ? "on" : "off"}</Badge>
                </Group>
                <Text size="sm" mb={6}>{b.what}</Text>
                <Text size="xs" c="dimmed">{b.how}</Text>
                <Text size="xs" c="dimmed" ff="monospace" mt={6}>{b.name}</Text>
              </Paper>
            ))}
          </SimpleGrid>
        )}
      </Loaded>

      <SectionTitle>Integrations</SectionTitle>
      <Text size="sm" c="dimmed" mb="sm" maw={760}>
        Connect the systems your team works with. Heinzel reaches them through MCP servers. Tokens are stored encrypted, and changes apply
        without a restart.
      </Text>
      <Loaded query={catalog}>
        {(entries) => (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mb="md">
            {entries.map((e) => (
              <Paper withBorder p="md" key={e.id}>
                <Stack gap={6} h="100%">
                  <Group justify="space-between" wrap="nowrap">
                    <Text fw={600}>{e.name}</Text>
                    {e.verified ? (
                      <Badge variant="light" color="green">verified</Badge>
                    ) : (
                      <Tooltip label="Prepared from the vendor's documentation, not yet tested against the real service">
                        <Badge variant="light" color="gray">not verified</Badge>
                      </Tooltip>
                    )}
                  </Group>
                  <Text size="sm" style={{ flex: 1 }}>{e.description}</Text>
                  <Group justify="space-between" mt={4}>
                    <Anchor href={e.docsUrl} target="_blank" rel="noreferrer" size="xs">How to set it up</Anchor>
                    {names.has(e.defaultName) ? (
                      <Badge variant="outline" color="green">connected as {e.defaultName}</Badge>
                    ) : (
                      canEdit && <Button size="xs" onClick={() => setConnecting(e)}>Connect</Button>
                    )}
                  </Group>
                </Stack>
              </Paper>
            ))}
          </SimpleGrid>
        )}
      </Loaded>

      <Group justify="space-between" mt="xl" mb="sm">
        <Title order={4}>Connected servers</Title>
        {canEdit && <Button variant="default" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing("new")}>Custom MCP server</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="sm" maw={760}>
        Servers from the deployment (mcp.json) are read-only here. Servers you add here must be reachable over HTTP (streamable HTTP). Servers
        that run as a command on the Heinzel host (stdio) can only be set up in the deployment.
      </Text>
      <Loaded query={servers}>
        {(rows) => (
          <Stack>
            {rows.length === 0 && <Text c="dimmed">No servers connected yet.</Text>}
            {rows.map((s) => (
              <ServerCard key={s.name} server={s} canEdit={canEdit} onEdit={() => setEditing(s)} />
            ))}
          </Stack>
        )}
      </Loaded>
      {editing && (
        <ServerForm
          server={editing === "new" ? null : editing}
          canStoreSecrets={config.data?.canStoreSecrets ?? true}
          onClose={() => setEditing(null)}
        />
      )}
      {connecting && (
        <CatalogForm
          entry={connecting}
          taken={names}
          canStoreSecrets={config.data?.canStoreSecrets ?? true}
          onClose={() => setConnecting(null)}
        />
      )}
    </>
  );
}

function CatalogForm({ entry, taken, canStoreSecrets, onClose }: { entry: CatalogEntryRow; taken: Set<string>; canStoreSecrets: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(taken.has(entry.defaultName) ? `${entry.defaultName}-2` : entry.defaultName);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(entry.fields.map((f) => [f.key, f.default ?? ""])));
  const [test, setTest] = useState<McpTestResponse | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const needsSecret = entry.fields.some((f) => f.secret);
  const complete = name.trim() !== "" && entry.fields.every((f) => (values[f.key] ?? "").trim() !== "");

  const runTest = useMutation({
    mutationFn: () => api<McpTestResponse>(`/api/mcp/catalog/${entry.id}/test`, { method: "POST", body: { name: name.trim(), values } }),
    onSuccess: (r) => {
      setTest(r);
      if (!r.error) setPicked(new Set(r.tools.filter((t) => t.exposedAs).map((t) => t.name)));
    },
    onError: (err) => setTest({ error: err.message, tools: [] }),
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/api/mcp/catalog/${entry.id}`, { method: "PUT", body: { name: name.trim(), values, ...(picked ? { tools: [...picked] } : {}) } }),
    onSuccess: () => {
      notifications.show({ message: `${entry.name} connected`, color: "green" });
      void qc.invalidateQueries({ queryKey: ["mcp"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
      onClose();
    },
    onError: (err) => notifications.show({ title: "Not saved", message: err.message, color: "red" }),
  });

  return (
    <Modal opened onClose={onClose} title={`Connect ${entry.name}`} size="lg">
      <Stack>
        {needsSecret && <SecretsKeyHint canStoreSecrets={canStoreSecrets} />}
        <Text size="sm">{entry.description}</Text>
        {entry.requires && <Alert color="blue">Needs: {entry.requires}</Alert>}
        {entry.fields.map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            description={f.help}
            placeholder={f.placeholder ?? undefined}
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={values[f.key] ?? ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setValues((old) => ({ ...old, [f.key]: v }));
              setTest(null);
              setPicked(null);
            }}
            required
          />
        ))}
        <TextInput
          label="Name"
          description="Prefix of the tool names (name__tool). Letters, digits and '-', at most 20 characters."
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        {test?.error && <Alert color="red" title="Connection failed">{test.error}</Alert>}
        {test && !test.error && (
          <Paper withBorder p="sm">
            <Text size="sm" fw={500} mb={4}>Connected. Choose the tools Heinzel may use:</Text>
            <Text size="xs" c="dimmed" mb="xs">The preselection follows the recommendation for this integration.</Text>
            <Stack gap={4} mah={260} style={{ overflowY: "auto" }}>
              {test.tools.map((t) => (
                <Checkbox
                  key={t.name}
                  label={<Text size="sm" ff="monospace">{t.name}</Text>}
                  checked={picked?.has(t.name) ?? false}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setPicked((old) => {
                      const next = new Set(old ?? []);
                      if (on) next.add(t.name);
                      else next.delete(t.name);
                      return next;
                    });
                  }}
                />
              ))}
            </Stack>
          </Paper>
        )}
        <Group justify="space-between">
          <Anchor href={entry.docsUrl} target="_blank" rel="noreferrer" size="sm">How to set it up</Anchor>
          <Group>
            <Button variant="default" onClick={() => runTest.mutate()} loading={runTest.isPending} disabled={!complete}>Test connection</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!complete || (!!test && !test.error && picked?.size === 0)}>Save</Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function ServerCard({ server: s, canEdit, onEdit }: { server: McpServerRow; canEdit: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(`/api/mcp/${encodeURIComponent(s.name)}`, { method: "DELETE" }),
    onSuccess: () => {
      notifications.show({ message: `${s.name} removed`, color: "green" });
      void qc.invalidateQueries({ queryKey: ["mcp"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
    },
    onError: (err) => notifications.show({ title: "Could not remove", message: err.message, color: "red" }),
  });
  const state = !s.enabled ? { label: "disabled", color: "gray" } : s.status?.error ? { label: "unavailable", color: "red" } : s.status ? { label: "connected", color: "green" } : { label: "pending", color: "yellow" };
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="xs" wrap="wrap">
        <Group gap="xs">
          <Title order={5}>{s.name}</Title>
          <Badge variant="light" color={state.color}>{state.label}</Badge>
          <Badge variant="outline" color="gray">{s.source === "deployment" ? "deployment" : "admin UI"}</Badge>
        </Group>
        {canEdit && s.source === "admin" && (
          <Group gap="xs">
            <Button size="xs" variant="default" onClick={onEdit}>Edit</Button>
            {confirm ? (
              <>
                <Button size="xs" color="red" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
                <Button size="xs" variant="subtle" onClick={() => setConfirm(false)}>Cancel</Button>
              </>
            ) : (
              <Button size="xs" variant="subtle" color="red" onClick={() => setConfirm(true)}>Remove…</Button>
            )}
          </Group>
        )}
      </Group>
      {s.url && <Text size="sm" ff="monospace" c="dimmed">{s.url}</Text>}
      {s.headerNames.length > 0 && <Text size="xs" c="dimmed">Headers: {s.headerNames.join(", ")} (values hidden)</Text>}
      {s.status?.error && <Alert color="red" mt="xs">{s.status.error}</Alert>}
      {s.status && s.status.tools.length > 0 && <ToolList tools={s.status.tools} />}
    </Paper>
  );
}

function ToolList({ tools }: { tools: { name: string; exposedAs: string | null }[] }) {
  return (
    <Table mt="xs">
      <Table.Tbody>
        {tools.map((t) => (
          <Table.Tr key={t.name}>
            <Table.Td w={32}>{t.exposedAs ? <IconCheck size={16} color="var(--mantine-color-green-6)" /> : <IconEyeOff size={16} color="var(--mantine-color-dimmed)" />}</Table.Td>
            <Table.Td><Text size="sm" ff="monospace" c={t.exposedAs ? undefined : "dimmed"}>{t.exposedAs ?? t.name}</Text></Table.Td>
            <Table.Td><Text size="xs" c="dimmed">{t.exposedAs ? "available to the agent" : "hidden by tools/exclude"}</Text></Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

const splitList = (s: string) => s.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);

function ServerForm({ server, canStoreSecrets, onClose }: { server: McpServerRow | null; canStoreSecrets: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>(server?.headerNames.map((n) => ({ name: n, value: "" })) ?? []);
  const [tools, setTools] = useState(server?.tools?.join(", ") ?? "");
  const [exclude, setExclude] = useState(server?.exclude.join(", ") ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [timeout, setTimeoutSec] = useState((server?.timeoutMs ?? 60_000) / 1000);
  const [test, setTest] = useState<McpTestResponse | null>(null);

  const body = (): McpServerInputBody => ({
    url: url.trim(),
    headers: Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])),
    tools: tools.trim() ? splitList(tools) : null,
    exclude: splitList(exclude),
    enabled,
    timeoutMs: Math.round(timeout * 1000),
  });
  const path = () => `/api/mcp/${encodeURIComponent(name.trim())}`;

  const runTest = useMutation({
    mutationFn: () => api<McpTestResponse>(`${path()}/test`, { method: "POST", body: body() }),
    onSuccess: setTest,
    onError: (err) => setTest({ error: err.message, tools: [] }),
  });
  const save = useMutation({
    mutationFn: () => api(path(), { method: "PUT", body: body() }),
    onSuccess: () => {
      notifications.show({ message: `${name} saved; connecting`, color: "green" });
      void qc.invalidateQueries({ queryKey: ["mcp"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
      onClose();
    },
    onError: (err) => notifications.show({ title: "Not saved", message: err.message, color: "red" }),
  });

  return (
    <Modal opened onClose={onClose} title={server ? `Edit ${server.name}` : "Add MCP server"} size="lg">
      <Stack>
        <SecretsKeyHint canStoreSecrets={canStoreSecrets} />
        <TextInput
          label="Name"
          description="Prefix of the tool names (name__tool). Letters, digits and '-', at most 20 characters."
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={!!server}
          required
        />
        <TextInput label="URL" description="Streamable HTTP endpoint, e.g. https://gitlab.example.com/api/v4/mcp" value={url} onChange={(e) => setUrl(e.currentTarget.value)} required />
        <div>
          <Text size="sm" fw={500}>Headers</Text>
          <Text size="xs" c="dimmed" mb={4}>
            For example Authorization: Bearer … Values are stored encrypted and never shown again. Leave a value empty to keep the stored one.
            ${"{VAR}"} reads an environment variable of the deployment.
          </Text>
          <Stack gap={6}>
            {headers.map((h, i) => (
              <Group key={i} gap={6} wrap="nowrap">
                <TextInput placeholder="Header" value={h.name} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)))} w={180} />
                <TextInput
                  placeholder={server?.headerNames.includes(h.name) ? "(unchanged)" : "Value"}
                  type="password"
                  autoComplete="off"
                  value={h.value}
                  onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.currentTarget.value } : x)))}
                  style={{ flex: 1 }}
                />
                <ActionIcon variant="subtle" color="red" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} aria-label="Remove header">
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            ))}
            <Button size="xs" variant="subtle" w="fit-content" leftSection={<IconPlus size={14} />} onClick={() => setHeaders([...headers, { name: "", value: "" }])}>
              Add header
            </Button>
          </Stack>
        </div>
        <TextInput label="Only these tools" description="Comma-separated, * as wildcard. Empty = all tools of the server." value={tools} onChange={(e) => setTools(e.currentTarget.value)} />
        <TextInput label="Hide these tools" description="Comma-separated, e.g. delete_*, create_*" value={exclude} onChange={(e) => setExclude(e.currentTarget.value)} />
        <Group>
          <NumberInput label="Timeout per call (seconds)" value={timeout} onChange={(v) => setTimeoutSec(Number(v) || 60)} min={1} max={600} w={200} />
          <Switch label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} mt="lg" />
        </Group>
        {test && (test.error ? <Alert color="red" title="Connection failed">{test.error}</Alert> : <Alert color="green" title={`Connected: ${test.tools.length} tools`}><ToolList tools={test.tools} /></Alert>)}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => runTest.mutate()} loading={runTest.isPending} disabled={!name.trim() || !url.trim()}>Test connection</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim() || !url.trim()}>Save</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function Model({ label, value }: { label: string; value: string | null }) {
  return (
    <Paper withBorder p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
      <Text size="sm" ff="monospace" style={{ wordBreak: "break-all" }}>{value ?? "not configured"}</Text>
    </Paper>
  );
}
