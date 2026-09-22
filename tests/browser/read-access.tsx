import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentDto, ReadAccessDto, UpdateReadAccessInput } from "../../src/shared/contracts";
import { readAccessApi } from "../../src/web/api";
import { ToastProvider } from "../../src/web/components/ui";
import { ReadAccessDialog } from "../../src/web/pages/AgentsPage";

// 在真正的浏览器 DOM 中运行生产组件，不需要数据库、凭证或额外测试依赖。
const root = createRoot(document.getElementById("fixture")!);
const output = document.getElementById("result")!;
const runButton = document.getElementById("run") as HTMLButtonElement;
const requests: { id: string; resolve: (value: ReadAccessDto) => void; reject: (reason: Error) => void }[] = [];
const writes: { id: string; input: UpdateReadAccessInput }[] = [];

function source(id: string): AgentDto {
  return { id, name: id, description: "", role: "reader", status: "active", deleting_at: null,
    display_mode: "feed", main_entry_id: null, created_at: "2026-09-22T00:00:00Z",
    last_report_at: null, last_result: null, last_note: null, read_mode: "selected", read_source_count: 0 };
}

function config(id: string, mode: "all" | "selected"): ReadAccessDto {
  return { agent_id: id, mode, revision: 0, sources: [] };
}

function show(id: string | null) {
  flushSync(() => root.render(<ToastProvider>{id ? <ReadAccessDialog key={id} agent={source(id)}
    sourceOptions={[]} onClose={() => show(null)} onSaved={() => undefined} /> : null}</ToastProvider>));
}

async function settle() {
  // 让 Promise 回调与 React 的 DOM 提交结束，不依赖网络延迟。
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
    .find((item) => item.textContent === text);
}

async function run() {
  runButton.disabled = true;
  output.textContent = "运行中…";
  const original = { ...readAccessApi };
  requests.length = 0;
  writes.length = 0;
  readAccessApi.get = (id) => new Promise((resolve, reject) => requests.push({ id, resolve, reject }));
  readAccessApi.replace = async (id, input) => {
    writes.push({ id, input });
    return { ...config(id, input.mode), revision: input.base_revision + 1 };
  };
  try {
    show("A");
    await settle();
    const pendingA = requests.at(-1)!;
    show("B");
    await settle();
    assert(!button("保存读取范围"), "加载中的 B 不能保存");
    requests.at(-1)!.resolve(config("B", "selected"));
    await settle();
    pendingA.resolve(config("A", "all"));
    await settle();
    assert(document.querySelector("select")?.value === "selected", "A 的迟到响应不得覆盖 B");
    button("保存读取范围")!.click();
    await settle();
    assert(writes.at(-1)?.id === "B" && writes.at(-1)?.input.mode === "selected", "保存必须针对 B 的配置");

    show(null);
    show("A");
    await settle();
    requests.at(-1)!.resolve(config("A", "all"));
    await settle();
    show("B");
    await settle();
    requests.at(-1)!.reject(new Error("模拟 B 加载失败"));
    await settle();
    assert(document.querySelector("dialog")?.textContent?.includes("模拟 B 加载失败"), "应显示加载错误");
    assert(!button("保存读取范围"), "B 加载失败不能保存 A 的旧配置");
    const retry = button("重新读取");
    assert(retry, "加载失败应提供重试");
    retry.click();
    await settle();
    requests.at(-1)!.resolve(config("B", "selected"));
    await settle();
    assert(button("保存读取范围")?.disabled === false, "重试成功后才允许保存");

    show(null);
    show("B");
    await settle();
    const oldB = requests.at(-1)!;
    show(null);
    show("B");
    await settle();
    requests.at(-1)!.resolve(config("B", "selected"));
    await settle();
    oldB.resolve(config("B", "all"));
    await settle();
    assert(document.querySelector("select")?.value === "selected", "重开同一 Agent 后不能接受上次的响应");
    output.textContent = "3 项通过：跨 Agent 迟到响应隔离；加载失败禁止保存及重试；关闭重开隔离。";
  } catch (error) {
    output.textContent = `失败：${error instanceof Error ? error.message : String(error)}`;
    throw error;
  } finally {
    show(null);
    Object.assign(readAccessApi, original);
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => { void run().catch(console.error); });
