pub type AppError = Box<dyn std::error::Error + Send + Sync>;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
