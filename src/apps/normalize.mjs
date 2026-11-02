// Preserve exact IDs from source URLs before considering JSON numeric fields.
function exactId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  const id = String(value ?? "");
  return /^\d+$/.test(id) ? id : "";
}
function sourceIdentity(value) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      !["api.zhihu.com", "www.zhihu.com", "zhuanlan.zhihu.com"].includes(
        u.hostname,
      )
    )
      return null;
    let m = u.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)\/?$/);
    if (m) return { kind: "answer", id: m[2], questionId: m[1] };
    m = u.pathname.match(
      /^\/(?:api\/v[34]\/)?(articles|answers|questions)\/(\d+)\/?$/,
    );
    if (m)
      return {
        kind: { articles: "article", answers: "answer", questions: "question" }[
          m[1]
        ],
        id: m[2],
      };
    m = u.pathname.match(/^\/(question|p)\/(\d+)\/?$/);
    if (m) return { kind: m[1] === "p" ? "article" : "question", id: m[2] };
  } catch {
    // Unparseable URL: fall through to null.
  }
  return null;
}
export function zhihuSearchRows(data) {
  return (data.data || []).flatMap((entry) => {
    const value = entry.target || entry.object || entry,
      source = sourceIdentity(value.url),
      kind = source?.kind || value.type,
      id = source?.id || exactId(value.id),
      question = sourceIdentity(value.question?.url);
    let url;
    if (!id) return [];
    if (kind === "article") url = `https://zhuanlan.zhihu.com/p/${id}`;
    if (kind === "question") url = `https://www.zhihu.com/question/${id}`;
    if (kind === "answer") {
      const questionId =
        source?.questionId ||
        (question?.kind === "question"
          ? question.id
          : exactId(value.question?.id));
      if (questionId)
        url = `https://www.zhihu.com/question/${questionId}/answer/${id}`;
    }
    return url
      ? [
          {
            type: kind,
            title: value.question?.title || value.title,
            author: value.author?.name,
            description: value.excerpt,
            url,
          },
        ]
      : [];
  });
}

// Modern browser/Node JSON reviver source preserves integers before IEEE-754 rounding.
export function parseExactJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value)
    ) {
      if (!/^-?\d+$/.test(context?.source || ""))
        throw Error("APP_RESPONSE_INVALID");
      return context.source;
    }
    return value;
  });
}

export function bilibiliDynamicRow(fields) {
  const value = Object.fromEntries(fields.map((x) => [x.field, x.value]));
  if (value.error) throw Error("APP_BODY_UNAVAILABLE");
  const ownText = [
    ...new Set([value.text, value.opus_text].filter(Boolean)),
  ].join("\n");
  return {
    items: [
      {
        url: value.url,
        title:
          value.opus_title ||
          value.video_title ||
          value.article_title ||
          "动态",
        author: value.author,
        time: value.time,
        description: [
          ownText,
          value.video_desc,
          value.forward_text ? "转发原文摘要：" + value.forward_text : "",
        ]
          .filter(Boolean)
          .join("\n"),
        cover: String(value.images || "").split("\n")[0],
        images: String(value.images || "")
          .split("\n")
          .filter(Boolean),
        truncated: !!(value.forward_text || value.opus_text),
      },
    ],
    next: null,
    coverage: value.video_title
      ? "video-metadata"
      : value.forward_text || value.opus_text
        ? "dynamic-summary"
        : ownText
          ? "dynamic-text"
          : "dynamic-metadata",
  };
}

export async function xiaohongshuLoginStatus(page) {
  // Consumer browsing does not require the separate creator-site session.
  // Keep identity and credentials in the browser; export only the current
  // webpage login flag.
  await page.goto("https://www.xiaohongshu.com/explore");
  await page.wait({ time: 2 });
  const payload = await page.evaluate(`
    (() => {
      if (location.origin !== 'https://www.xiaohongshu.com')
        return { error: 'APP_UPSTREAM_FAILED' };
      if (/website-login\\/error|error_code=300017|error_code=300031/.test(location.href))
        return { error: 'APP_VERIFICATION_REQUIRED' };
      if (/^\\/login(?:\\/|$)/.test(location.pathname))
        return { loggedIn: false };
      const unwrap = value => value && typeof value === 'object'
        ? value.__v_isRef === true && 'value' in value ? value.value
          : '_value' in value ? value._value : value
        : value;
      const probe = el => el?.__vue_app__?.config?.globalProperties?.$pinia;
      let pinia = probe(document.querySelector('#app'));
      if (!pinia) {
        for (const el of document.querySelectorAll('*')) {
          pinia = probe(el);
          if (pinia) break;
        }
      }
      const user = pinia?._s?.get('user') || window.__INITIAL_STATE__?.user;
      const loggedIn = unwrap(user?.loggedIn);
      if (loggedIn === false) return { loggedIn: false };
      const info = unwrap(user?.userInfo);
      const id = info?.userId || info?.user_id;
      if (loggedIn === true && typeof id === 'string' && id.trim())
        return { loggedIn: true };
      const text = document.body?.innerText || '';
      if (/安全验证|人机验证|请完成验证|滑动验证/.test(text))
        return { error: 'APP_VERIFICATION_REQUIRED' };
      if (/登录后查看|请先登录/.test(text)) return { loggedIn: false };
      return { error: 'APP_UPSTREAM_FAILED' };
    })()
  `);
  const result =
    payload &&
    typeof payload === "object" &&
    "session" in payload &&
    "data" in payload
      ? payload.data
      : payload;
  if (result?.error)
    throw Error(
      result.error === "APP_VERIFICATION_REQUIRED"
        ? "APP_VERIFICATION_REQUIRED"
        : "APP_UPSTREAM_FAILED",
    );
  if (typeof result?.loggedIn !== "boolean")
    throw Error("APP_RESPONSE_INVALID");
  return { loggedIn: result.loggedIn, status: "checked" };
}
