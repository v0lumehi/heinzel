import { SegmentedControl, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type MemoryRow } from "../api";
import { Loaded, PageHeader } from "../components";
import { MemoryTable } from "../tables";

export function MemoriesPage({ canEdit }: { canEdit: boolean }) {
  const [scope, setScope] = useState("all");
  const [text, setText] = useState("");
  const [q] = useDebouncedValue(text, 300);
  const params = new URLSearchParams({ ...(scope !== "all" ? { scope } : {}), ...(q ? { q } : {}) });
  const memories = useQuery({ queryKey: ["memories", scope, q], queryFn: () => api<MemoryRow[]>(`/api/memories?${params}`) });
  return (
    <>
      <PageHeader title="Memories">
        <SegmentedControl
          value={scope}
          onChange={setScope}
          data={[
            { value: "all", label: "All" },
            { value: "channel", label: "Channel" },
            { value: "org", label: "Organization" },
            { value: "user", label: "Person" },
          ]}
        />
      </PageHeader>
      <TextInput
        mb="md"
        maw={420}
        leftSection={<IconSearch size={16} />}
        placeholder="Search memories"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <Loaded query={memories}>{(rows) => <MemoryTable rows={rows} canEdit={canEdit} />}</Loaded>
    </>
  );
}
