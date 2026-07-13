/**
 * レシピ取得 Lambda関数
 * - URLのページを取得してテキストを抽出
 * - Amazon Bedrock（Claude）でレシピ情報をJSON化
 * - API Gatewayから呼び出される
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "us-east-1" }); // Bedrockは東京未対応のためバージニア北部

export const handler = async (event) => {
  // CORS対応（プリフライトリクエスト）
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
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
          "Accept-Language": "ja,en;q=0.9",
        },
        signal: AbortSignal.timeout(8000),
      });
      const html = await res.text();
      // HTMLタグを除去してテキストのみ抽出（最大8000文字）
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

    // 2. Bedrockでレシピ情報を抽出
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
      modelId: "anthropic.claude-3-haiku-20240307-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const bedrockRes = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockRes.body));
    const text = responseBody.content[0].text;

    // JSONを抽出
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return corsResponse(500, { error: "レシピ情報を解析できませんでした" });
    }

    const recipe = JSON.parse(match[0]);
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
