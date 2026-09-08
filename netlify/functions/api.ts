import { getUser } from "@netlify/identity";
import { withLambda } from "@netlify/aws-lambda-compat";
import serverless from "serverless-http";
import { createApp } from "../../server/index";
import { loadConfig } from "../../server/config";

const app = createApp(loadConfig());
const expressFunction = withLambda(serverless(app));

export default async function api(request: Request, context: Parameters<typeof expressFunction>[1]) {
  const user = await getUser();
  if (!user) {
    return Response.json(
      { error: "unauthorized", message: "Bu işlem için yönetici oturumu açmalısınız." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return expressFunction(request, context);
}
