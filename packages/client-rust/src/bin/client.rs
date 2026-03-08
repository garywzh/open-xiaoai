use open_xiaoai::services::audio::config::AudioConfig;
use open_xiaoai::services::monitor::file::FileMonitorEvent;
use open_xiaoai::services::monitor::instruction::{InstructionMonitor, LogMessage, Payload};
use open_xiaoai::services::monitor::kws::KwsMonitor;
use open_xiaoai::services::monitor::playing::PlayingMonitor;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::time::sleep;
use tokio_tungstenite::connect_async;

use open_xiaoai::base::AppError;
use open_xiaoai::base::VERSION;
use open_xiaoai::services::audio::play::AudioPlayer;
use open_xiaoai::services::audio::record::AudioRecorder;
use open_xiaoai::services::connect::data::{Event, Request, Response, Stream};
use open_xiaoai::services::connect::handler::MessageHandler;
use open_xiaoai::services::connect::message::{MessageManager, WsStream};
use open_xiaoai::services::connect::rpc::RPC;

const SUPPRESSED_DIALOG_TTL: Duration = Duration::from_secs(15);
const COMMON_WAKE_PREFIXES: &[&str] = &["小爱同学", "小爱", "你好小爱", "嗨小爱"];

static REPLY_SUPPRESSOR: LazyLock<LocalReplySuppressor> = LazyLock::new(LocalReplySuppressor::new);

struct AppClient {
    kws_monitor: KwsMonitor,
    instruction_monitor: InstructionMonitor,
    playing_monitor: PlayingMonitor,
    reply_suppressor: LocalReplySuppressor,
}

impl AppClient {
    pub fn new() -> Self {
        Self {
            kws_monitor: KwsMonitor::new(),
            instruction_monitor: InstructionMonitor::new(),
            playing_monitor: PlayingMonitor::new(),
            reply_suppressor: REPLY_SUPPRESSOR.clone(),
        }
    }

    pub async fn connect(&self, url: &str) -> Result<WsStream, AppError> {
        let (ws_stream, _) = connect_async(url).await?;
        Ok(WsStream::Client(ws_stream))
    }

    pub async fn run(&mut self) {
        let url = std::env::args().nth(1).expect("❌ 请输入服务器地址");
        println!("✅ 已启动");
        loop {
            let Ok(ws_stream) = self.connect(&url).await else {
                sleep(Duration::from_secs(1)).await;
                continue;
            };
            println!("✅ 已连接: {:?}", url);
            self.init(ws_stream).await;
            if let Err(e) = MessageManager::instance().process_messages().await {
                eprintln!("❌ 消息处理异常: {}", e);
            }
            self.dispose().await;
            eprintln!("❌ 已断开连接");
        }
    }

    async fn init(&mut self, ws_stream: WsStream) {
        MessageManager::instance().init(ws_stream).await;
        MessageHandler::<Event>::instance()
            .set_handler(on_event)
            .await;
        MessageHandler::<Stream>::instance()
            .set_handler(on_stream)
            .await;

        let rpc = RPC::instance();
        rpc.add_command("get_version", get_version).await;
        rpc.add_command("run_shell", run_shell).await;
        rpc.add_command("start_play", start_play).await;
        rpc.add_command("stop_play", stop_play).await;
        rpc.add_command("start_recording", start_recording).await;
        rpc.add_command("stop_recording", stop_recording).await;
        rpc.add_command("set_dialog_mode", set_dialog_mode).await;

        let reply_suppressor = self.reply_suppressor.clone();
        self.instruction_monitor
            .start(move |event| {
                let reply_suppressor = reply_suppressor.clone();
                async move {
                    reply_suppressor.on_instruction_event(&event).await;
                    MessageManager::instance()
                        .send_event("instruction", Some(json!(event)))
                        .await
                }
            })
            .await;

        self.playing_monitor
            .start(|event| async move {
                MessageManager::instance()
                    .send_event("playing", Some(json!(event)))
                    .await
            })
            .await;

        self.kws_monitor
            .start(|event| async move {
                MessageManager::instance()
                    .send_event("kws", Some(json!(event)))
                    .await
            })
            .await;
    }

    async fn dispose(&mut self) {
        MessageManager::instance().dispose().await;
        let _ = AudioPlayer::instance().stop().await;
        let _ = AudioRecorder::instance().stop_recording().await;
        self.instruction_monitor.stop().await;
        self.playing_monitor.stop().await;
        self.kws_monitor.stop().await;
        self.reply_suppressor.clear().await;
    }
}

struct DialogTrace {
    recognized_at: Instant,
    text: String,
    allow_native: bool,
}

#[derive(Clone)]
struct LocalReplySuppressor {
    dialogs: Arc<Mutex<HashMap<String, DialogTrace>>>,
}

impl LocalReplySuppressor {
    fn new() -> Self {
        println!("✅ 本地抢话拦截已启用（由服务端显式裁决原生/桥接）");
        Self {
            dialogs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn on_instruction_event(&self, event: &FileMonitorEvent) {
        match event {
            FileMonitorEvent::NewFile => {
                self.clear().await;
            }
            FileMonitorEvent::NewLine(line) => {
                self.handle_instruction_line(line).await;
            }
        }
    }

    async fn handle_instruction_line(&self, line: &str) {
        self.cleanup().await;

        let Ok(message) = serde_json::from_str::<LogMessage>(line) else {
            return;
        };

        let dialog_id = message.header.dialog_id.trim();
        if dialog_id.is_empty() {
            return;
        }

        match message.payload {
            Payload::RecognizeResultPayload { results, .. } => {
                let text = results
                    .first()
                    .map(|item| item.text.trim())
                    .unwrap_or_default();
                if self.should_track_dialog(text) {
                    println!("⏱️ [client] asr_final dialog={} mode=pending text={}", dialog_id, text);
                    let mut dialogs = self.dialogs.lock().await;
                    dialogs.insert(
                        dialog_id.to_string(),
                        DialogTrace {
                            recognized_at: Instant::now(),
                            text: text.to_string(),
                            allow_native: false,
                        },
                    );
                }
            }
            Payload::SpeakPayload { .. } | Payload::PlayPayload { .. } => {
                let dialog_trace = {
                    let mut dialogs = self.dialogs.lock().await;
                    dialogs.remove(dialog_id)
                };

                if let Some(dialog_trace) = dialog_trace {
                    let elapsed_since_asr = dialog_trace.recognized_at.elapsed().as_millis();
                    let dialog_id = dialog_id.to_string();
                    let text = dialog_trace.text;

                    if dialog_trace.allow_native {
                        println!(
                            "⏱️ [client] native_reply_allowed dialog={} since_asr={}ms text={}",
                            dialog_id, elapsed_since_asr, text
                        );
                        return;
                    }

                    println!(
                        "⏱️ [client] native_reply_detected dialog={} since_asr={}ms text={}",
                        dialog_id, elapsed_since_asr, text
                    );
                    tokio::spawn(async move {
                        let interrupt_started_at = Instant::now();
                        match interrupt_xiaoai_local().await {
                            Ok(_) => println!(
                                "⏱️ [client] local_interrupt_done dialog={} cmd={}ms since_asr={}ms text={}",
                                dialog_id,
                                interrupt_started_at.elapsed().as_millis(),
                                elapsed_since_asr,
                                text
                            ),
                            Err(error) => eprintln!("❌ 本地拦截失败 dialog={}: {}", dialog_id, error),
                        }
                    });
                }
            }
            _ => {}
        }
    }

    async fn set_dialog_mode(&self, dialog_id: &str, allow_native: bool, text: Option<&str>) {
        let dialog_id = dialog_id.trim();
        if dialog_id.is_empty() {
            return;
        }

        let mut dialogs = self.dialogs.lock().await;
        let entry = dialogs
            .entry(dialog_id.to_string())
            .or_insert_with(|| DialogTrace {
                recognized_at: Instant::now(),
                text: text.unwrap_or_default().trim().to_string(),
                allow_native,
            });

        entry.allow_native = allow_native;
        if entry.text.is_empty() {
            if let Some(text) = text {
                entry.text = text.trim().to_string();
            }
        }

        println!(
            "⏱️ [client] dialog_mode_set dialog={} allow_native={} text={}",
            dialog_id,
            allow_native,
            entry.text
        );
    }

    async fn clear(&self) {
        self.dialogs.lock().await.clear();
    }

    async fn cleanup(&self) {
        let mut dialogs = self.dialogs.lock().await;
        dialogs.retain(|_, trace| trace.recognized_at.elapsed() < SUPPRESSED_DIALOG_TTL);
    }

    fn should_track_dialog(&self, text: &str) -> bool {
        let normalized = strip_wake_prefixes(&normalize_text(text));
        !normalized.is_empty()
    }
}

#[derive(Deserialize)]
struct DialogModePayload {
    dialog_id: String,
    allow_native: bool,
    #[serde(default)]
    text: Option<String>,
}

fn normalize_text(text: &str) -> String {
    text.chars()
        .filter(|ch| {
            !ch.is_whitespace()
                && !matches!(
                    ch,
                    '，' | '。' | '？' | '！' | '、' | '：' | '；' | ',' | '.' | '?' | '!'
                        | ':' | ';' | '"' | '\'' | '“' | '”' | '‘' | '’' | '（' | '）'
                        | '(' | ')'
                )
        })
        .collect()
}

fn strip_wake_prefixes(text: &str) -> String {
    let mut normalized = text.to_string();

    loop {
        let mut changed = false;
        for prefix in COMMON_WAKE_PREFIXES {
            let prefix = normalize_text(prefix);
            if normalized.starts_with(&prefix) {
                normalized = normalized[prefix.len()..].to_string();
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    normalized
}

fn summarize_script(script: &str) -> String {
    let single_line = script
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ; ");

    let summary = if single_line.is_empty() {
        script.trim().to_string()
    } else {
        single_line
    };

    if summary.chars().count() <= 120 {
        summary
    } else {
        let mut trimmed = summary.chars().take(120).collect::<String>();
        trimmed.push_str("...");
        trimmed
    }
}

async fn interrupt_xiaoai_local() -> Result<(), AppError> {
    open_xiaoai::utils::shell::run_shell(
        r#"
            mphelper pause >/dev/null 2>&1 || true
            ubus -t1 -S call pnshelper event_notify '{"src":3, "event":7}' >/dev/null 2>&1 || true
            sleep 0.1
            ubus -t1 -S call pnshelper event_notify '{"src":3, "event":8}' >/dev/null 2>&1 || true
            (/etc/init.d/mico_aivs_lab restart >/dev/null 2>&1 &) || true
            exit 0
        "#,
    )
    .await?;
    Ok(())
}

async fn get_version(_: Request) -> Result<Response, AppError> {
    let data = json!(VERSION.to_string());
    Ok(Response::from_data(data))
}

async fn start_play(request: Request) -> Result<Response, AppError> {
    let config = request
        .payload
        .and_then(|payload| serde_json::from_value::<AudioConfig>(payload).ok());
    AudioPlayer::instance().start(config).await?;
    Ok(Response::success())
}

async fn stop_play(_: Request) -> Result<Response, AppError> {
    AudioPlayer::instance().stop().await?;
    Ok(Response::success())
}

async fn start_recording(request: Request) -> Result<Response, AppError> {
    let config = request
        .payload
        .and_then(|payload| serde_json::from_value::<AudioConfig>(payload).ok());
    AudioRecorder::instance()
        .start_recording(
            |bytes| async {
                MessageManager::instance()
                    .send_stream("record", bytes, None)
                    .await
            },
            config,
        )
        .await?;
    Ok(Response::success())
}

async fn stop_recording(_: Request) -> Result<Response, AppError> {
    AudioRecorder::instance().stop_recording().await?;
    Ok(Response::success())
}

async fn set_dialog_mode(request: Request) -> Result<Response, AppError> {
    let payload = match request.payload {
        Some(payload) => serde_json::from_value::<DialogModePayload>(payload)?,
        None => return Err("empty dialog mode payload".into()),
    };

    let dialog_id = payload.dialog_id.trim();
    if dialog_id.is_empty() {
        return Err("dialog_id is required".into());
    }

    REPLY_SUPPRESSOR
        .set_dialog_mode(dialog_id, payload.allow_native, payload.text.as_deref())
        .await;
    Ok(Response::success())
}

async fn run_shell(request: Request) -> Result<Response, AppError> {
    let script = match request.payload {
        Some(payload) => serde_json::from_value::<String>(payload)?,
        _ => return Err("empty command".into()),
    };
    let started_at = Instant::now();
    let summary = summarize_script(&script);
    println!("⏱️ [client] rpc_run_shell_start script={}", summary);
    let res = open_xiaoai::utils::shell::run_shell(script.as_str()).await?;
    println!(
        "⏱️ [client] rpc_run_shell_done cost={}ms exit_code={} script={}",
        started_at.elapsed().as_millis(),
        res.exit_code,
        summary
    );
    Ok(Response::from_data(json!(res)))
}

async fn on_event(event: Event) -> Result<(), AppError> {
    println!("🔥 收到事件: {:?}", event);
    Ok(())
}

async fn on_stream(stream: Stream) -> Result<(), AppError> {
    let Stream { tag, bytes, .. } = stream;
    if tag.as_str() == "play" {
        let _ = AudioPlayer::instance().play(bytes).await;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    AppClient::new().run().await;
}
