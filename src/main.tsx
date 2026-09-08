import React from "react";
import ReactDOM from "react-dom/client";
import App from "./online/OnlineApp";
import { BootReady } from "./loading/LoadingScreen";
import "./styles.css";
import "./mobile/mobile.css";
import "./table/table.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootReady />
    <App />
  </React.StrictMode>,
);
