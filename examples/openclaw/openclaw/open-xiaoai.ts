import { createRequire } from "node:module";

const native = createRequire(import.meta.url)("./open-xiaoai.node");

export const RustServer = {
  start: native.start as () => Promise<void>,
  run_shell: native.runShell as (script: string, timeout: number) => Promise<string>,
  set_dialog_mode: native.setDialogMode as (dialogId: string, allowNative: boolean, text?: string) => Promise<boolean>,
  on_output_data: native.onOutputData as (bytes: Uint8Array) => Promise<boolean>,
};
