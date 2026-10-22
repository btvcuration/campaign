// ✨ [변경 후]
// 🌟 [추가됨] 프론트엔드가 확장앱 설치 여부와 버전을 즉시 인식할 수 있도록 DOM에 마커 삽입
if (!document.getElementById('btv-campaign-extension-installed')) {
  const checkNode = document.createElement('div');
  checkNode.id = 'btv-campaign-extension-installed';
  checkNode.style.display = 'none';
  
  // 🌟 [핵심 수정] 하드코딩을 지우고, manifest.json 파일의 버전을 실시간으로 읽어옵니다!
  const manifest = chrome.runtime.getManifest();
  checkNode.setAttribute('data-version', manifest.version || '1.3'); 
  
  document.body.appendChild(checkNode);
}

// 1. 기존 Jira 전송 신호 중계 (React -> Extension -> Jira)
window.addEventListener('TEST_JIRA_SEND', (e) => {
  chrome.runtime.sendMessage({
    action: "OPEN_JIRA_TEST",
    data: e.detail
  });
});

// 2. 네이티브 캡처 및 이미지 자르기(크롭)
window.addEventListener('REQUEST_SCREENSHOT', (e) => {
  const rect = e.detail;
  try {
    chrome.runtime.sendMessage({ action: "TAKE_SCREENSHOT" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.dataUrl) {
        window.dispatchEvent(new CustomEvent('RECEIVE_SCREENSHOT', { detail: { dataUrl: null } }));
        return;
      }
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = rect.width;
        canvas.height = rect.height;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        ctx.drawImage(img, rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr, 0, 0, rect.width, rect.height);
        const croppedDataUrl = canvas.toDataURL('image/png');
        window.dispatchEvent(new CustomEvent('RECEIVE_SCREENSHOT', { detail: { dataUrl: croppedDataUrl } }));
      };
      img.onerror = () => {
        window.dispatchEvent(new CustomEvent('RECEIVE_SCREENSHOT', { detail: { dataUrl: null } }));
      };
      img.src = response.dataUrl;
    });
  } catch (err) {
    window.dispatchEvent(new CustomEvent('RECEIVE_SCREENSHOT', { detail: { dataUrl: null } }));
  }
});

// 🌟 [추가됨] 프론트엔드의 Jira 세션 체크 요청을 백그라운드로 전달
window.addEventListener('REQUEST_JIRA_SESSION', () => {
  chrome.runtime.sendMessage({ action: 'CHECK_JIRA_SESSION' }, (response) => {
    window.dispatchEvent(new CustomEvent('RECEIVE_JIRA_SESSION', { detail: response }));
  });
});

// 🌟 [신규 추가] 캘린더/목록에서 프로모션 삭제 시 Jira 티켓 취소/삭제 신호 중계
window.addEventListener('CANCEL_JIRA_ISSUE', (e) => {
  chrome.runtime.sendMessage({
    action: "CANCEL_JIRA_ISSUE",
    data: e.detail
  }, (response) => {
    window.dispatchEvent(new CustomEvent('RECEIVE_JIRA_CANCEL', { detail: response }));
  });
});
