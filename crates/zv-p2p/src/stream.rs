//! Потоки поверх обоих транспортов: QUIC-поток iroh или поток libp2p (Yamux поверх TCP / QUIC).

use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt};

use crate::MAX_FRAME;

type LpIo = Compat<libp2p::Stream>;
type LpRead = Arc<tokio::sync::Mutex<Option<ReadHalf<LpIo>>>>;

/// Передающая сторона потока libp2p. Читающая половина общая с [`LpRecv`]: по ней `stopped()`
/// узнаёт, что собеседник дочитал и закрыл поток.
pub struct LpSend {
    w: Option<WriteHalf<LpIo>>,
    r: LpRead,
}

pub struct LpRecv {
    r: LpRead,
}

pub enum StreamSend {
    Iroh(iroh::endpoint::SendStream),
    Lp(LpSend),
}

pub enum StreamRecv {
    Iroh(iroh::endpoint::RecvStream),
    Lp(LpRecv),
}

pub(crate) fn lp_pair(s: libp2p::Stream) -> (StreamSend, StreamRecv) {
    let (r, w) = tokio::io::split(s.compat());
    let r = Arc::new(tokio::sync::Mutex::new(Some(r)));
    (
        StreamSend::Lp(LpSend {
            w: Some(w),
            r: r.clone(),
        }),
        StreamRecv::Lp(LpRecv { r }),
    )
}

impl StreamSend {
    pub async fn write_all(&mut self, b: &[u8]) -> anyhow::Result<()> {
        match self {
            StreamSend::Iroh(s) => s.write_all(b).await?,
            StreamSend::Lp(l) => {
                let w =
                    l.w.as_mut()
                        .ok_or_else(|| anyhow::anyhow!("поток закрыт"))?;
                w.write_all(b).await?;
            }
        }
        Ok(())
    }

    /// Данных больше не будет: собеседник дочитает и получит конец потока.
    pub async fn finish(&mut self) -> anyhow::Result<()> {
        match self {
            StreamSend::Iroh(s) => s.finish()?,
            StreamSend::Lp(l) => {
                if let Some(w) = l.w.as_mut() {
                    w.shutdown().await?;
                }
            }
        }
        Ok(())
    }

    /// Оборвать поток: собеседник получит ошибку.
    pub fn reset(&mut self, code: u32) {
        match self {
            StreamSend::Iroh(s) => {
                let _ = s.reset(code.into());
            }
            StreamSend::Lp(l) => {
                l.w = None;
                if let Ok(mut g) = l.r.try_lock() {
                    g.take();
                }
            }
        }
    }

    /// Дождаться, пока собеседник примет всё отправленное (или бросит поток).
    pub async fn stopped(&mut self) -> anyhow::Result<()> {
        match self {
            StreamSend::Iroh(s) => {
                let _ = s.stopped().await;
            }
            StreamSend::Lp(l) => {
                let mut g = l.r.lock().await;
                if let Some(r) = g.as_mut() {
                    let mut sink = [0u8; 1024];
                    while r.read(&mut sink).await.unwrap_or(0) > 0 {}
                }
            }
        }
        Ok(())
    }
}

impl StreamRecv {
    /// `Ok(None)` — поток закончился.
    pub async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<Option<usize>> {
        match self {
            StreamRecv::Iroh(r) => Ok(r.read(buf).await?),
            StreamRecv::Lp(l) => {
                let mut g = l.r.lock().await;
                let r = g
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("поток остановлен"))?;
                let n = r.read(buf).await?;
                Ok((n > 0).then_some(n))
            }
        }
    }

    pub async fn read_to_end(&mut self, limit: usize) -> anyhow::Result<Vec<u8>> {
        if let StreamRecv::Iroh(r) = self {
            return Ok(r.read_to_end(limit).await?);
        }
        let mut out = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        while let Some(n) = self.read(&mut buf).await? {
            out.extend_from_slice(&buf[..n]);
            anyhow::ensure!(out.len() <= limit, "больше {limit} байт");
        }
        Ok(out)
    }

    /// Больше не читаем.
    pub fn stop(&mut self, code: u32) {
        match self {
            StreamRecv::Iroh(r) => {
                let _ = r.stop(code.into());
            }
            StreamRecv::Lp(l) => {
                if let Ok(mut g) = l.r.try_lock() {
                    g.take();
                }
            }
        }
    }

    /// Заполнить `buf` целиком; `false` — поток кончился до первого байта.
    async fn fill(&mut self, buf: &mut [u8]) -> anyhow::Result<bool> {
        let mut got = 0;
        while got < buf.len() {
            match self.read(&mut buf[got..]).await? {
                Some(n) => got += n,
                None if got == 0 => return Ok(false),
                None => anyhow::bail!("поток оборвался посреди кадра"),
            }
        }
        Ok(true)
    }
}

/// Кадр JSON (длина u32 BE + UTF-8). `Ok(None)` — поток закрыт между кадрами.
pub async fn read_frame(r: &mut StreamRecv) -> anyhow::Result<Option<Value>> {
    let mut len = [0u8; 4];
    if !r.fill(&mut len).await? {
        return Ok(None);
    }
    let n = u32::from_be_bytes(len) as usize;
    anyhow::ensure!(n <= MAX_FRAME, "кадр {n} байт — больше предела");
    let mut buf = vec![0u8; n];
    anyhow::ensure!(
        n == 0 || r.fill(&mut buf).await?,
        "поток оборвался посреди кадра"
    );
    Ok(Some(serde_json::from_slice(&buf)?))
}
