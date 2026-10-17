import { Badge, Paper, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, type ChannelRow, type SettingsResponse } from "../api";
import { EmptyRow, Loaded, PageHeader } from "../components";
import { channelLabel, fmtDate, fmtNumber, platformLabel } from "../format";

export function ChannelsPage() {
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => api<ChannelRow[]>("/api/channels") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/api/settings") });
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Channels" />
      <Loaded query={channels}>
        {(rows) => (
          <Paper withBorder>
            <Table.ScrollContainer minWidth={800}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Channel</Table.Th>
                    <Table.Th>Platform</Table.Th>
                    <Table.Th>Ambient</Table.Th>
                    <Table.Th ta="right">Unprompted 24h</Table.Th>
                    <Table.Th ta="right">LLM calls 7d</Table.Th>
                    <Table.Th ta="right">Tokens 7d</Table.Th>
                    <Table.Th>Last activity</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.length === 0 && <EmptyRow cols={7} text="No channels yet. They appear once someone writes to the bot." />}
                  {rows.map((c) => (
                    <Table.Tr key={c.channelKey} style={{ cursor: "pointer" }} onClick={() => navigate(`/channels/${encodeURIComponent(c.channelKey)}`)}>
                      <Table.Td>
                        <Text fw={500}>{channelLabel(c)}</Text>
                        {c.instructions && <Text size="xs" c="dimmed">has instructions</Text>}
                      </Table.Td>
                      <Table.Td>{platformLabel(c.platform)}</Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={c.ambientEnabled ? "green" : "gray"}>{c.ambientEnabled ? "on" : "off"}</Badge>
                      </Table.Td>
                      <Table.Td ta="right">
                        {c.unsolicitedLast24h} / {c.dailyUnsolicitedLimit ?? settings.data?.ambientDailyLimit ?? "–"}
                      </Table.Td>
                      <Table.Td ta="right">{fmtNumber(c.callsLast7d)}</Table.Td>
                      <Table.Td ta="right">{fmtNumber(c.tokensLast7d)}</Table.Td>
                      <Table.Td>{fmtDate(c.lastActivity)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        )}
      </Loaded>
    </>
  );
}
