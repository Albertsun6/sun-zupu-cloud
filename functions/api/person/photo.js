// Cloudflare Pages Function —— 存照片(第二版预留)
// 路由:POST /api/person/photo
// 第一版明确返回 501,避免调用方以为已接通。鉴权仍走 PERSON_WRITE_TOKEN。

import { handlePersonPhotoRequest } from "../_person-write.js";

export async function onRequestPost(context) {
  return handlePersonPhotoRequest(context);
}
