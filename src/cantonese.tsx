import {
  Action,
  ActionPanel,
  environment,
  getPreferenceValues,
  Icon,
  List,
  LocalStorage,
  showToast,
  Toast,
} from "@vicinae/api";
import { join } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Dictionary,
  type Entry,
  FLAG_CANTO,
  FLAG_CEDICT,
  FLAG_DERIVED,
  forgetUsage,
  loadDictionary,
  recent,
  recordUsage,
  search,
  type Usage,
} from "./search";

type Preferences = { script: "traditional" | "simplified"; showDetail: boolean };

const USAGE_KEY = "usage-v1";
const EMPTY_USAGE: Usage = { entries: {}, queries: {} };

// Survives re-renders and, if the extension process is reused, repeat launches.
let dictPromise: Promise<Dictionary> | undefined;
function getDictionary() {
  dictPromise ??= new Promise((resolve, reject) => {
    // Defer so the first frame (search bar + loading indicator) renders before parsing.
    setTimeout(() => {
      try {
        resolve(loadDictionary(join(environment.assetsPath, "dict.json")));
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
  return dictPromise;
}

async function loadUsage(): Promise<Usage> {
  try {
    const raw = await LocalStorage.getItem<string>(USAGE_KEY);
    return raw ? { ...EMPTY_USAGE, ...JSON.parse(raw) } : EMPTY_USAGE;
  } catch {
    return EMPTY_USAGE;
  }
}

function sources(e: Entry) {
  const s = [];
  if (e.flags & FLAG_CANTO) s.push("CC-Canto");
  if (e.flags & FLAG_CEDICT) s.push("CC-CEDICT");
  return s.join(" + ");
}

function detailMarkdown(e: Entry) {
  const chars = e.simp !== e.trad ? `${e.trad}　${e.simp}` : e.trad;
  const defs = e.defs.map((d, i) => `${i + 1}. ${d.replace(/([*_`[\]\\])/g, "\\$1")}`).join("\n");
  const pinyin = e.pinyin ? `　·　${e.pinyin}` : "";
  return `# ${chars}\n\n**${e.jyutping}**${pinyin}\n\n${defs}`;
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const [dict, setDict] = useState<Dictionary>();
  const [usage, setUsage] = useState<Usage>(EMPTY_USAGE);
  const [query, setQuery] = useState("");
  const [showDetail, setShowDetail] = useState(prefs.showDetail ?? true);
  const usageRef = useRef(usage);

  useEffect(() => {
    getDictionary().then(setDict, (e) =>
      showToast({ style: Toast.Style.Failure, title: "Couldn't load dictionary", message: String(e) }),
    );
    loadUsage().then((u) => {
      usageRef.current = u;
      setUsage(u);
    });
  }, []);

  const updateUsage = (f: (u: Usage) => Usage) => {
    const next = f(usageRef.current);
    usageRef.current = next;
    setUsage(next);
    LocalStorage.setItem(USAGE_KEY, JSON.stringify(next));
  };

  const results = useMemo(() => (dict && query.trim() ? search(dict, query, usage) : []), [dict, query, usage]);
  const recents = useMemo(() => (dict && !query.trim() ? recent(dict, usage) : []), [dict, query, usage]);

  const renderItem = (e: Entry) => {
    const primary = prefs.script === "simplified" ? e.simp : e.trad;
    const secondary = prefs.script === "simplified" ? e.trad : e.simp;
    const used = () => updateUsage((u) => recordUsage(u, e.id, query));
    const accessories: List.Item.Accessory[] = [];
    if (!showDetail) accessories.push({ text: e.defs[0] });
    if (e.flags & FLAG_DERIVED) accessories.push({ tag: "reading guessed", tooltip: "No dictionary reading; derived per character" });

    return (
      <List.Item
        key={e.id}
        id={e.id}
        title={primary}
        subtitle={e.jyutping}
        accessories={accessories}
        detail={
          <List.Item.Detail
            markdown={detailMarkdown(e)}
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label title="Jyutping" text={e.jyutping} />
                {e.pinyin && <List.Item.Detail.Metadata.Label title="Pinyin" text={e.pinyin} />}
                {e.simp !== e.trad && <List.Item.Detail.Metadata.Label title="Simplified" text={e.simp} />}
                <List.Item.Detail.Metadata.Label title="Source" text={sources(e)} />
                {usage.entries[e.id] && (
                  <List.Item.Detail.Metadata.Label title="Times used" text={String(usage.entries[e.id].n)} />
                )}
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={
          <ActionPanel>
            <Action.Paste title={`Paste ${primary}`} content={primary} onPaste={used} />
            <Action.CopyToClipboard title={`Copy ${primary}`} content={primary} onCopy={used} />
            {secondary !== primary && (
              <Action.Paste
                title={`Paste ${secondary}`}
                content={secondary}
                onPaste={used}
                shortcut={{ key: "return", modifiers: ["shift"] }}
              />
            )}
            <Action.CopyToClipboard
              title="Copy Jyutping"
              content={e.jyutping}
              shortcut={{ key: "j", modifiers: ["ctrl"] }}
            />
            <Action.CopyToClipboard
              title="Copy Entry"
              content={`${e.trad} (${e.jyutping}): ${e.defs.join("; ")}`}
              shortcut={{ key: "c", modifiers: ["ctrl", "shift"] }}
            />
            <Action
              title={showDetail ? "Hide Definitions" : "Show Definitions"}
              icon={Icon.AppWindowSidebarRight}
              shortcut={{ key: "d", modifiers: ["ctrl"] }}
              onAction={() => setShowDetail((s) => !s)}
            />
            {usage.entries[e.id] && (
              <Action
                title="Forget Usage"
                icon={Icon.Trash}
                style="destructive"
                shortcut={{ key: "x", modifiers: ["ctrl"] }}
                onAction={() => updateUsage((u) => forgetUsage(u, e.id))}
              />
            )}
          </ActionPanel>
        }
      />
    );
  };

  return (
    <List
      isLoading={!dict}
      isShowingDetail={showDetail}
      filtering={false}
      throttle
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Jyutping (nei5 hou2, neihou), English, or 中文…"
    >
      {query.trim() ? (
        results.length ? (
          <List.Section title="Results" subtitle={String(results.length)}>
            {results.map((r) => renderItem(r.entry))}
          </List.Section>
        ) : (
          dict && <List.EmptyView title="No matches" description="Try fewer words, or drop the tones" />
        )
      ) : recents.length ? (
        <List.Section title="Recently used">{recents.map(renderItem)}</List.Section>
      ) : (
        dict && (
          <List.EmptyView
            title="Cantonese lookup"
            description="Type jyutping (sik6 faan6, sikfaan) or an English definition (to eat)"
          />
        )
      )}
    </List>
  );
}
