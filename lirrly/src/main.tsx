// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 mshrmnsr
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/theme.css";
import FlowBar from "./flowbar/FlowBar";
import Settings from "./settings/Settings";

// Pick the view by Tauri window label. `?view=` overrides it (used for design
// previews in a plain browser, where the Tauri runtime isn't present).
function resolveView(): "flowbar" | "settings" {
  const param = new URLSearchParams(location.search).get("view");
  if (param === "flowbar" || param === "settings") return param;
  try {
    return getCurrentWindow().label === "flowbar" ? "flowbar" : "settings";
  } catch {
    return "settings";
  }
}

const View = resolveView() === "flowbar" ? FlowBar : Settings;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<View />);
