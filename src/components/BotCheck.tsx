import { useEffect, useRef, useState } from 'react';
export interface BotCheckRequest {
  siteKey: string;
  resolve: (token: string) => void;
  reject: () => void;
}
export function requestBotCheck(siteKey: string): Promise<string> {
  return new Promise((resolve, reject) =>
    window.dispatchEvent(
      new CustomEvent<BotCheckRequest>('archive-bot-check', {
        detail: {
          siteKey,
          resolve,
          reject: () => reject(new Error('확인을 취소했습니다. 잠시 후 다시 시도해 주세요.')),
        },
      }),
    ),
  );
}
export default function BotCheck() {
  const [request, setRequest] = useState<BotCheckRequest>();
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const widget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      setRequest((event as CustomEvent<BotCheckRequest>).detail);
      setError('');
    };
    window.addEventListener('archive-bot-check', listener);
    return () => window.removeEventListener('archive-bot-check', listener);
  }, []);
  useEffect(() => {
    if (request) dialog.current?.showModal();
    else dialog.current?.close();
  }, [request]);
  const cancel = () => {
    request?.reject();
    setRequest(undefined);
  };
  const verify = async () => {
    try {
      if (!(window as any).turnstile) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
          script.onload = () => resolve();
          script.onerror = () => {
            script.remove();
            reject(new Error('확인 서비스를 연결하지 못했습니다.'));
          };
          document.head.append(script);
        });
      }
      if (!request || !widget.current) return;
      widget.current.replaceChildren();
      (window as any).turnstile.render(widget.current, {
        sitekey: request.siteKey,
        action: 'archive-read',
        callback: (token: string) => {
          request.resolve(token);
          setRequest(undefined);
        },
        'error-callback': () => setError('확인을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'),
        'expired-callback': () => setError('확인 시간이 만료되었습니다. 다시 확인해 주세요.'),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '확인을 연결하지 못했습니다.');
    }
  };
  return (
    <dialog
      ref={dialog}
      className="context-dialog"
      aria-label="계속 열람 확인"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <div className="context-dialog-body">
        <h2>계속 열람 확인</h2>
        <p>
          요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도하거나 확인 후 계속 읽을 수 있습니다.
        </p>
        <button className="button primary" onClick={verify}>
          확인하고 계속 읽기
        </button>
        <div ref={widget} />
        {error && <p role="alert">{error}</p>}
        <button className="button secondary" onClick={cancel}>
          닫기
        </button>
      </div>
    </dialog>
  );
}
