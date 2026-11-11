/** 状态栏消息通道（避免 EditorScene 与 EditorUI 互相 import） */
let sink: ((text: string) => void) | null = null;

export function setStatusSink(fn: (text: string) => void): void {
  sink = fn;
}

export function setStatus(text: string): void {
  sink?.(text);
}
