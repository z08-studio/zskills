use std::{env, path::PathBuf};
use zskills::{
    http::create_app,
    service::{ServiceOptions, SkillsService},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = env::var("PORT")
        .unwrap_or_else(|_| "4173".into())
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or("PORT must be an integer between 1 and 65535.")?;
    let client_root = env::var_os("ZSKILLS_CLIENT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist/client"));
    let service = SkillsService::new(ServiceOptions::default())?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("ZSkills is available at http://localhost:{port}");
    let shutdown_service = service.clone();
    axum::serve(listener, create_app(service, client_root))
        .with_graceful_shutdown(async move {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("Register SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            shutdown_service.dispose();
        })
        .await?;
    Ok(())
}
