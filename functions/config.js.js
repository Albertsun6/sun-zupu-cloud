// 路由:GET /config.js(CF Pages:文件名 config.js.js = 路径含 .js)
// 从环境变量输出 window.SB,供 index.html 的 <script src="config.js"> 使用。

import { configJsResponse } from "./api/_shared.js";

export async function onRequestGet({ env }) { return configJsResponse(env); }
