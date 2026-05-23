import { useMemo, useState } from "react";
import { stripAnsi, detectLevel } from "../lib/log-utils";
import type { LevelFilter } from "../lib/log-utils";

export function useLogFilter(logs: string[]) {
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");

  function toggleFilter(key: LevelFilter) {
    setLevelFilter((prev) => (prev === key ? "all" : key));
  }

  const cleanLogs = useMemo(() => logs.map(stripAnsi), [logs]);

  const filteredLogs = useMemo(() => {
    const lower = search.toLowerCase();
    return cleanLogs
      .map((line, i) => ({ line, originalIndex: i }))
      .filter(({ line }) => {
        if (search && !line.toLowerCase().includes(lower)) return false;
        if (levelFilter !== "all" && detectLevel(line) !== levelFilter) return false;
        return true;
      });
  }, [cleanLogs, search, levelFilter]);

  function reset() {
    setSearch("");
    setLevelFilter("all");
  }

  return { search, setSearch, levelFilter, setLevelFilter, toggleFilter, filteredLogs, reset };
}
