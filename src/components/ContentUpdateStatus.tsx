import { useEffect, useState } from 'react';

interface Status {
  schema: string;
  version: string;
  commit: string;
  checkedAt: string;
}

export default function ContentUpdateStatus() {
  const [status, setStatus] = useState<Status>();
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}content-update.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Update status unavailable');
        return response.json();
      })
      .then((data) => {
        if (
          data.schema === 'hsr-content-update.v1' &&
          typeof data.version === 'string' &&
          /^[a-f0-9]{40}$/.test(data.commit) &&
          !Number.isNaN(Date.parse(data.checkedAt))
        )
          setStatus(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return (
    <section>
      <h2>원문 자동 갱신</h2>
      <p>
        6시간마다 최신 릴리스 자료를 확인해 연결된 한국어 원문과 자료실 기록을 갱신합니다. 새 임무는
        목차와 장면 연결을 확인한 뒤 수록합니다. 연결을 확인할 수 없는 문장은 기존 원문을
        유지합니다.
      </p>
      {status && (
        <p>
          자료 버전: {status.version}
          <br />
          최근 확인:{' '}
          {new Date(status.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국
          시간)
        </p>
      )}
    </section>
  );
}
