import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "ap-northeast-1" });

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return corsResponse(200, {});
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const url = body.url;

    if (!url) {
      return corsResponse(400, { error: "URLが指定されていません" });
    }

    // 1. URLのHTMLを取得
    let pageText = "";
    let imageUrl = null;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
          "Accept-Language": "ja,en;q=0.9",
        },
        signal: AbortSignal.timeout(8000),
      });
      const html = await res.text();

      // og:image からメイン画像URLを抽出
      const ogImage =
        html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogImage) imageUrl = ogImage[1];

      // テキスト抽出
      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8000);
    } catch (e) {
      return corsResponse(400, { error: "URLの取得に失敗しました: " + e.message });
    }

    // 2. Nova Liteでレシピ情報を抽出
    const prompt = `以下のレシピページのテキストからレシピ情報を抽出してJSONのみを返してください。前置きや説明は不要です。

テキスト:
${pageText}

返すJSON形式（厳密にこの形式のみ）:
{
  "name": "レシピ名",
  "description": "簡単な説明（1〜2文）",
  "time": 調理時間の分数（数値のみ、不明ならnull）,
  "servings": 人数（数値のみ、不明ならnull）,
  "difficulty": 難易度（1=かんたん/2=ふつう/3=むずかしい）,
  "category": "和食/洋食/中華/イタリアン/アジア/スイーツ/その他 のいずれか",
  "ingredients": [{"name": "材料名", "amount": "量"}],
  "steps": ["手順1", "手順2"],
  "tags": ["タグ1", "タグ2"]
}`;

    const command = new InvokeModelCommand({
      modelId: "amazon.nova-lite-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { max_new_tokens: 2000 }
      }),
    });

    const bedrockRes = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockRes.body));
    const text = responseBody.output.message.content[0].text;

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return corsResponse(500, { error: "レシピ情報を解析できませんでした" });
    }

    const recipe = JSON.parse(match[0]);

    // 画像をLambdaで取得してBase64で返す（CORSを回避）
    if (imageUrl) {
      try {
        const imgRes = await fetch(imageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
            "Referer": url,
          },
          signal: AbortSignal.timeout(5000),
        });
        if (imgRes.ok) {
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";
          const buffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          recipe.imageBase64 = `data:${contentType};base64,${base64}`;
        }
      } catch (e) {
        // 画像取得失敗は無視
      }
    }

    return corsResponse(200, recipe);

  } catch (e) {
    console.error(e);
    return corsResponse(500, { error: "サーバーエラー: " + e.message });
  }
};

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
