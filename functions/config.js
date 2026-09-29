// 路由:GET /config(_redirects 把 /config.js 200 回写到这里,作路由兜底)

import { configJsResponse } from "./api/_shared.js";

export async function onRequestGet({ env }) { return configJsResponse(env); }
