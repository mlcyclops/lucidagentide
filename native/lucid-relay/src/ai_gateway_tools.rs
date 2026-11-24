// Contract API-1 revision 6 section 8.7 (slice API-1d6): tool calling toward the gateway's backends. The gateway
// gives the backend the definitions of the offered organization tools and runs at most 4 rounds of tool calls, then
// asks for a final answer with tool use turned off. Each provider's own form: the OpenAI chat API (Local Providers,
// OpenAI, Azure OpenAI: `tools`, `tool_calls`, `tool` turns), the Anthropic Messages API (`tool_use`,
// `tool_result`) and AWS Bedrock Converse (`toolConfig`, `toolUse`, `toolResult`). The request's URL, keys and AWS
// signature come from `ai_gateway_backend::build_with`.

use crate::ai_gateway_backend::{build_with, Backends, Credential, Prompt};
use crate::ai_gateway_cards::Card;
use serde_json::{json, Value};
use std::time::Duration;

/// The rounds of tool calls before the final answer (8.7).
pub const ROUNDS_MAX: usize = 4;

/// One tool as the model sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// A call the model asked for: `args` is the JSON text the model wrote.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: String,
}

/// What a tool gave back (or the error given to the model in its place).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutput {
    pub id: String,
    pub text: String,
    pub error: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Turn {
    Assistant { text: String, calls: Vec<ToolCall> },
    Results(Vec<ToolOutput>),
}

/// One backend call of a tool conversation. `final_round`: tool use is turned off (the definitions stay, as the
/// providers require them while earlier turns hold tool calls).
pub struct Conversation<'a> {
    pub prompt: &'a Prompt,
    pub tools: &'a [ToolDef],
    pub turns: &'a [Turn],
    pub final_round: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reply {
    pub text: String,
    pub calls: Vec<ToolCall>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
}

/// Whether the gateway's adapter for a provider does tool calling (a backend without it gets no tools).
pub fn supports(provider: &str) -> bool {
    matches!(provider, "local" | "openai" | "azure" | "anthropic" | "amazon-bedrock")
}

/// A model-facing tool name: `t<n>_` and the tool's name with anything outside `[A-Za-z0-9_-]` as `_`, at most 64.
pub fn model_name(n: usize, tool: &str) -> String {
    let clean: String = tool.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    let mut out = format!("t{n}_{clean}");
    out.truncate(64);
    out
}

fn args_object(text: &str) -> Value {
    serde_json::from_str::<Value>(text).ok().filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn openai_body(card: &Card, c: &Conversation, max_key: &str) -> Value {
    let mut messages = vec![json!({"role": "system", "content": c.prompt.system}), json!({"role": "user", "content": c.prompt.user})];
    for t in c.turns {
        match t {
            Turn::Assistant { text, calls } => {
                let calls: Vec<Value> = calls.iter().map(|k| json!({"id": k.id, "type": "function", "function": {"name": k.name, "arguments": k.args}})).collect();
                let content = if text.is_empty() { Value::Null } else { json!(text) };
                messages.push(json!({"role": "assistant", "content": content, "tool_calls": calls}));
            }
            Turn::Results(outs) => {
                for o in outs {
                    messages.push(json!({"role": "tool", "tool_call_id": o.id, "content": o.text}));
                }
            }
        }
    }
    let tools: Vec<Value> = c.tools.iter().map(|d| json!({"type": "function", "function": {"name": d.name, "description": d.description, "parameters": d.schema}})).collect();
    let mut v = json!({"model": card.model, "messages": messages, "temperature": 0, "stream": false});
    v[max_key] = json!(c.prompt.max_output);
    if !tools.is_empty() {
        v["tools"] = json!(tools);
        v["tool_choice"] = json!(if c.final_round { "none" } else { "auto" });
    }
    v
}

fn anthropic_body(card: &Card, c: &Conversation) -> Value {
    let mut messages = vec![json!({"role": "user", "content": c.prompt.user})];
    for t in c.turns {
        match t {
            Turn::Assistant { text, calls } => {
                let mut blocks: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({"type": "text", "text": text}));
                }
                blocks.extend(calls.iter().map(|k| json!({"type": "tool_use", "id": k.id, "name": k.name, "input": args_object(&k.args)})));
                messages.push(json!({"role": "assistant", "content": blocks}));
            }
            Turn::Results(outs) => {
                let blocks: Vec<Value> = outs.iter().map(|o| json!({"type": "tool_result", "tool_use_id": o.id, "content": o.text, "is_error": o.error})).collect();
                messages.push(json!({"role": "user", "content": blocks}));
            }
        }
    }
    let mut v = json!({"model": card.model, "max_tokens": c.prompt.max_output, "temperature": 0, "system": c.prompt.system, "messages": messages});
    if !c.tools.is_empty() {
        v["tools"] = json!(c.tools.iter().map(|d| json!({"name": d.name, "description": d.description, "input_schema": d.schema})).collect::<Vec<_>>());
        v["tool_choice"] = json!({"type": if c.final_round { "none" } else { "auto" }});
    }
    v
}

fn bedrock_body(c: &Conversation) -> Value {
    let mut messages = vec![json!({"role": "user", "content": [{"text": c.prompt.user}]})];
    for t in c.turns {
        match t {
            Turn::Assistant { text, calls } => {
                let mut blocks: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({"text": text}));
                }
                blocks.extend(calls.iter().map(|k| json!({"toolUse": {"toolUseId": k.id, "name": k.name, "input": args_object(&k.args)}})));
                messages.push(json!({"role": "assistant", "content": blocks}));
            }
            Turn::Results(outs) => {
                let blocks: Vec<Value> = outs.iter().map(|o| json!({"toolResult": {"toolUseId": o.id, "content": [{"text": o.text}], "status": if o.error { "error" } else { "success" }}})).collect();
                messages.push(json!({"role": "user", "content": blocks}));
            }
        }
    }
    let mut v = json!({"messages": messages, "system": [{"text": c.prompt.system}], "inferenceConfig": {"maxTokens": c.prompt.max_output, "temperature": 0}});
    if !c.tools.is_empty() {
        // Converse has no "none" choice: in the final round the gateway ignores any call it still asks for
        v["toolConfig"] = json!({"tools": c.tools.iter().map(|d| json!({"toolSpec": {"name": d.name, "description": d.description, "inputSchema": {"json": d.schema}}})).collect::<Vec<_>>()});
    }
    v
}

/// The provider's body for a tool conversation.
pub fn body(card: &Card, c: &Conversation) -> Result<Vec<u8>, String> {
    let v = match card.provider.as_str() {
        "local" => openai_body(card, c, "max_tokens"),
        "openai" | "azure" => openai_body(card, c, "max_completion_tokens"),
        "anthropic" => anthropic_body(card, c),
        "amazon-bedrock" => bedrock_body(c),
        other => return Err(format!("the gateway has no tool calling for {other}")),
    };
    Ok(v.to_string().into_bytes())
}

/// The text, the tool calls and the usage of a provider's answer.
pub fn parse(provider: &str, raw: &[u8]) -> Result<Reply, String> {
    let v: Value = serde_json::from_slice(raw).map_err(|_| "the backend's answer is not JSON".to_string())?;
    let n = |x: &Value| x.as_u64();
    let input = |x: &Value| if x.is_object() { x.to_string() } else { "{}".to_string() };
    match provider {
        "anthropic" => {
            let blocks = v["content"].as_array().ok_or("the backend's answer has no content")?;
            let text: String = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
            let calls = blocks
                .iter()
                .filter(|b| b["type"] == "tool_use")
                .map(|b| ToolCall { id: b["id"].as_str().unwrap_or_default().into(), name: b["name"].as_str().unwrap_or_default().into(), args: input(&b["input"]) })
                .collect();
            Ok(Reply { text, calls, tokens_in: n(&v["usage"]["input_tokens"]), tokens_out: n(&v["usage"]["output_tokens"]) })
        }
        "amazon-bedrock" => {
            let blocks = v["output"]["message"]["content"].as_array().ok_or("the backend's answer has no content")?;
            let text: String = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
            let calls = blocks
                .iter()
                .filter_map(|b| b.get("toolUse"))
                .map(|t| ToolCall { id: t["toolUseId"].as_str().unwrap_or_default().into(), name: t["name"].as_str().unwrap_or_default().into(), args: input(&t["input"]) })
                .collect();
            Ok(Reply { text, calls, tokens_in: n(&v["usage"]["inputTokens"]), tokens_out: n(&v["usage"]["outputTokens"]) })
        }
        _ => {
            let m = &v["choices"][0]["message"];
            if !m.is_object() {
                return Err("the backend's answer has no message".into());
            }
            let calls = m["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| ToolCall { id: t["id"].as_str().unwrap_or_default().into(), name: t["function"]["name"].as_str().unwrap_or_default().into(), args: t["function"]["arguments"].as_str().unwrap_or("{}").into() })
                .collect();
            Ok(Reply { text: m["content"].as_str().unwrap_or_default().into(), calls, tokens_in: n(&v["usage"]["prompt_tokens"]), tokens_out: n(&v["usage"]["completion_tokens"]) })
        }
    }
}

/// One round. Err holds no content (the backend's status at most).
pub async fn complete(backends: &Backends, card: &Card, cred: &Credential, c: &Conversation<'_>, timeout: Duration) -> Result<Reply, String> {
    let o = build_with(card, cred, body(card, c)?, crate::meet_json::now() as i64)?;
    let (status, raw) = backends.send("POST", &o, timeout).await?;
    if !(200..300).contains(&status) {
        return Err(format!("the backend answered {status}"));
    }
    let mut r = parse(&card.provider, &raw)?;
    if c.final_round {
        r.calls.clear();
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_gateway_cards::testcards::*;

    fn conv_parts() -> (Prompt, Vec<ToolDef>, Vec<Turn>) {
        let p = Prompt { system: "sys".into(), user: "question".into(), max_output: 256 };
        let tools = vec![ToolDef { name: "t1_search".into(), description: "Jira: search".into(), schema: json!({"type": "object"}) }];
        let turns = vec![
            Turn::Assistant { text: String::new(), calls: vec![ToolCall { id: "c1".into(), name: "t1_search".into(), args: "{\"q\":\"tampa\"}".into() }] },
            Turn::Results(vec![ToolOutput { id: "c1".into(), text: "ISSUE-1".into(), error: false }]),
        ];
        (p, tools, turns)
    }

    #[test]
    fn each_provider_carries_the_tools_the_calls_and_the_results() {
        let (p, tools, turns) = conv_parts();
        let c = Conversation { prompt: &p, tools: &tools, turns: &turns, final_round: false };
        let openai: Value = serde_json::from_slice(&body(&frontier_card("o", "openai", "https://api.openai.com/v1", &["public"]).pipe(), &c).unwrap()).unwrap();
        assert_eq!(openai["tools"][0]["function"]["name"], "t1_search");
        assert_eq!(openai["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"q\":\"tampa\"}");
        assert_eq!(openai["messages"][3]["role"], "tool");
        assert_eq!(openai["tool_choice"], "auto");
        let anthropic: Value = serde_json::from_slice(&body(&frontier_card("a", "anthropic", "https://api.anthropic.com", &["public"]).pipe(), &c).unwrap()).unwrap();
        assert_eq!(anthropic["messages"][1]["content"][0]["input"], json!({"q": "tampa"}));
        assert_eq!(anthropic["messages"][2]["content"][0]["tool_use_id"], "c1");
        let last = Conversation { prompt: &p, tools: &tools, turns: &turns, final_round: true };
        let fin: Value = serde_json::from_slice(&body(&frontier_card("a", "anthropic", "https://api.anthropic.com", &["public"]).pipe(), &last).unwrap()).unwrap();
        assert_eq!(fin["tool_choice"], json!({"type": "none"}));
        let bedrock: Value = serde_json::from_slice(&body(&frontier_card("b", "amazon-bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com", &["public"]).pipe(), &c).unwrap()).unwrap();
        assert_eq!(bedrock["messages"][2]["content"][0]["toolResult"]["status"], "success");
    }

    #[test]
    fn replies_with_tool_calls_parse_for_every_provider() {
        let o = br#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"x","type":"function","function":{"name":"t1_a","arguments":"{\"q\":1}"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}"#;
        let r = parse("openai", o).unwrap();
        assert_eq!((r.text.as_str(), r.calls[0].args.as_str(), r.tokens_in), ("", "{\"q\":1}", Some(5)));
        let a = br#"{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"y","name":"t1_a","input":{"q":1}}],"usage":{"input_tokens":5,"output_tokens":2}}"#;
        assert_eq!(parse("anthropic", a).unwrap().calls[0].id, "y");
        let b = br#"{"output":{"message":{"content":[{"toolUse":{"toolUseId":"z","name":"t1_a","input":{"q":1}}}]}},"usage":{"inputTokens":5,"outputTokens":2}}"#;
        assert_eq!(parse("amazon-bedrock", b).unwrap().calls[0].name, "t1_a");
        assert_eq!(model_name(3, "jira.search issues"), "t3_jira_search_issues");
    }

    trait Pipe {
        fn pipe(self) -> Card;
    }

    impl Pipe for Value {
        fn pipe(self) -> Card {
            crate::ai_gateway_cards::check_card(&self).unwrap()
        }
    }
}
