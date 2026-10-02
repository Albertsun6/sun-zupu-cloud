// Cloudflare Pages Function —— 挂/改人物关系(给主人的聊天助手)
// 路由:POST /api/person/relation
// 第一版只收 type=father(规则同网页 reconcileFatherEdge,不写退役列 father_id)。
// 第二版将开放 type=spouse。鉴权:PERSON_WRITE_TOKEN(fail-closed)。

import { handlePersonRelationRequest } from "../_person-write.js";

export async function onRequestPost(context) {
  return handlePersonRelationRequest(context);
}
