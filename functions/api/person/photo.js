// Cloudflare Pages Function —— 存/删照片(聊天助手写接口第二版)
// 路由:POST /api/person/photo  DELETE /api/person/photo?media_id=
// 鉴权:PERSON_WRITE_TOKEN(fail-closed)。网页撤销:上传=photo:person 不可撤;删除=delete:media 可撤(文件仍在桶里)。

import { handlePersonPhotoRequest } from "../_person-write.js";

export async function onRequestPost(context) {
  return handlePersonPhotoRequest(context);
}

export async function onRequestDelete(context) {
  return handlePersonPhotoRequest(context);
}
