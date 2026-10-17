import { Alert, Badge, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { IconCheck, IconEyeOff } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { api, type SettingsResponse, type ToolsResponse } from "../api";
import { Loaded, PageHeader, SectionTitle } from "../components";

export function ToolsPage() {
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api<ToolsResponse>("/api/tools") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/api/settings") });
  return (
    <>
      <PageHeader title="Tools" />
      <Text c="dimmed" mb="md">
        Configured in the deployment (MCP_CONFIG and environment). Editing tool servers here is planned.
      </Text>
      {settings.data && (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} mb="lg">
          <Model label="Agent model" value={settings.data.models.agent} />
          <Model label="Triage model" value={settings.data.models.triage} />
          <Model label="Heavy model" value={settings.data.models.heavy} />
          <Model label="Coding model" value={settings.data.models.coding} />
        </SimpleGrid>
      )}
      <Loaded query={tools}>
        {(t) => (
          <>
            <SectionTitle>Built-in</SectionTitle>
            <Group gap="xs">
              {t.builtin.map((name) => <Badge key={name} variant="light" tt="none">{name}</Badge>)}
            </Group>
            <SectionTitle>MCP servers</SectionTitle>
            {t.servers.length === 0 && <Text c="dimmed">No MCP servers configured.</Text>}
            <Stack>
              {t.servers.map((s) => (
                <Paper withBorder p="md" key={s.server}>
                  <Group justify="space-between" mb="xs">
                    <Title order={5}>{s.server}</Title>
                    <Badge color={s.error ? "red" : "green"} variant="light">{s.error ? "unavailable" : "connected"}</Badge>
                  </Group>
                  {s.error && <Alert color="red" mb="xs">{s.error}</Alert>}
                  <Table>
                    <Table.Tbody>
                      {s.tools.map((tool) => (
                        <Table.Tr key={tool.name}>
                          <Table.Td w={32}>{tool.exposedAs ? <IconCheck size={16} color="var(--mantine-color-green-6)" /> : <IconEyeOff size={16} color="var(--mantine-color-dimmed)" />}</Table.Td>
                          <Table.Td><Text size="sm" ff="monospace" c={tool.exposedAs ? undefined : "dimmed"}>{tool.exposedAs ?? tool.name}</Text></Table.Td>
                          <Table.Td><Text size="xs" c="dimmed">{tool.exposedAs ? "available to the agent" : "hidden by tools/exclude"}</Text></Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Paper>
              ))}
            </Stack>
          </>
        )}
      </Loaded>
    </>
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
