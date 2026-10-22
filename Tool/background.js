// 🌟 description 안의 mermaid 코드 블록을 찾아냄
const MERMAID_BLOCK_REGEX = /<!--MERMAID_START-->([\s\S]*?)<!--MERMAID_END-->/;
function extractMermaidBlock(desc) {
  if (!desc) return null;
  const match = desc.match(MERMAID_BLOCK_REGEX);
  if (!match) return null;
  return { fullMatch: match[0], code: match[1].trim() };
}

// 🌟 mermaid.ink로 mermaid 코드 → PNG Blob 변환 (한글 포함 UTF-8 안전 처리)
async function mermaidToPngBlob(mermaidCode) {
  const utf8Bytes = new TextEncoder().encode(mermaidCode);
  let binary = '';
  utf8Bytes.forEach(b => { binary += String.fromCharCode(b); });
  const base64 = btoa(binary);
  const url = `https://mermaid.ink/img/${encodeURIComponent(base64)}?type=png&bgColor=white`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mermaid.ink 렌더링 실패 (HTTP ${res.status})`);
  return await res.blob();
}

const CF_WORKER_URL = "https://btv-proxy.alcheminos.workers.dev";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, maxRetries = 3) {
  let baseDelay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      await sleep(retryAfter ? parseInt(retryAfter) * 1000 : baseDelay);
      baseDelay *= 2; continue;
    }
    if (response.status === 401) throw new Error(`[401 Unauthorized] Jira 세션이 만료되었습니다. 다시 로그인해주세요.`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[HTTP ${response.status}] 서버 에러 발생!\n응답 내용: ${errorText.substring(0, 200)}...`);
    }
    return response;
  }
  throw new Error("서버 응답 지연으로 최대 재시도 횟수를 초과했습니다.");
}

function dataURLtoBlob(dataurl) {
  let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1], bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
  while(n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new Blob([u8arr], { type: mime });
}

// 🌟 이슈의 기존 첨부파일을 모두 삭제 (수정 재전송 시 이미지 누적 방지)
async function deleteAllAttachments(baseUrl, issueKey) {
  try {
    const res = await fetchWithRetry(
      `${baseUrl}/rest/api/2/issue/${issueKey}?fields=attachment`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' }
    );
    const data = await res.json();
    const attachments = data.fields?.attachment || [];
    for (const att of attachments) {
      await fetchWithRetry(
        `${baseUrl}/rest/api/2/attachment/${att.id}`,
        { method: 'DELETE', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include' }
      );
    }
  } catch (e) {
    console.warn(`⚠️ [${issueKey}] 기존 첨부파일 삭제 중 문제 발생:`, e.message);
  }
}

const formatLabel = (str) => str ? str.replace(/\s+/g, '_') : '';

chrome.action.onClicked.addListener((tab) => chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" }));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchCapaCsv') {
    fetch('https://btv-proxy.alcheminos.workers.dev/?action=getCapaCsv')
      .then(res => res.text()).then(csvText => sendResponse({ success: true, data: csvText }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "OPEN_JIRA_TEST") {
    createJiraHierarchy(message.data, sender.tab.id);
    sendResponse({ status: "processing" });
    return true;
  }
  if (message.action === "TAKE_SCREENSHOT") {
    const targetWindowId = sender.tab ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) sendResponse({ dataUrl: null });
      else sendResponse({ dataUrl: dataUrl });
    });
    return true;
  }
  if (message.action === "CHECK_JIRA_SESSION") {
    fetch("https://jira.skbroadband.com/rest/api/2/myself", { credentials: "include" })
      .then(res => sendResponse({ isLogged: res.ok && !res.headers.get("content-type")?.includes("text/html") }))
      .catch(e => sendResponse({ isLogged: false }));
    return true;
  }
  if (message.action === "CANCEL_JIRA_ISSUE") {
    cancelOrDeleteJiraIssue(message.data)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ status: "error", message: err.message }));
    return true;
  }
});

async function createJiraHierarchy(data, sourceTabId) {
  const baseUrl = "https://jira.skbroadband.com";
  const MERMAID_PLACEHOLDER = "___MERMAID_DIAGRAM_PLACEHOLDER___";
  const mermaidBlock = extractMermaidBlock(data.parent.desc);
  if (mermaidBlock) {
    data.parent.desc = data.parent.desc.replace(mermaidBlock.fullMatch, MERMAID_PLACEHOLDER);
  }
  const projectKey = "BTVMKT";
  const targetUserId = data.parent?.assignee || "system";
  const PARENT_ISSUE_TYPE = "Task", CHILD_ISSUE_TYPE = "Sub-Task";
  const START_DATE_FIELD = "customfield_10134", FINISH_DATE_FIELD = "customfield_10135";
  let parentKey = data.parentJiraKey || "";
  let createdIssues = [];

  try {
    // 🌟 1단계: Jira 상위 이슈 및 하위 Sub-task 생성/업데이트
    if (!data.skipJira) {
      const uniqueLabels = Array.from(new Set((data.children || []).flatMap(c => (c.gnb || []).map(formatLabel))));
      const safeInitialDesc = data.parent.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
      const parentFields = {
        project: { key: projectKey }, summary: data.parent.title, description: safeInitialDesc,
        issuetype: { name: PARENT_ISSUE_TYPE }, reporter: { name: targetUserId }, assignee: { name: targetUserId }, labels: uniqueLabels
      };
      if (data.parent.startDate) parentFields[START_DATE_FIELD] = data.parent.startDate;
      if (data.parent.dueDate) parentFields[FINISH_DATE_FIELD] = data.parent.dueDate;

      if (parentKey) {
        const updateFields = { ...parentFields }; delete updateFields.project; delete updateFields.issuetype;
        await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: updateFields }) });
        await deleteAllAttachments(baseUrl, parentKey);
        const pRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
        const pData = await pRes.json();
        const existingSubtasks = pData.fields?.subtasks || [];
        
        for (let i = 0; i < data.children.length; i++) {
          const childData = data.children[i];
          const safeChildDesc = childData.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
          const childFields = {
            project: { key: projectKey }, summary: childData.title, description: safeChildDesc,
            issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey },
            reporter: { name: targetUserId }, assignee: { name: childData.assignee || targetUserId }, labels: (childData.gnb || []).map(formatLabel)
          };
          if (childData.startDate) childFields[START_DATE_FIELD] = childData.startDate;
          if (childData.dueDate) childFields[FINISH_DATE_FIELD] = childData.dueDate;
          
          if (i < existingSubtasks.length) {
            const subKey = existingSubtasks[i].key;
            await deleteAllAttachments(baseUrl, subKey);
            const cUpdateFields = { ...childFields }; delete cUpdateFields.project; delete cUpdateFields.issuetype; delete cUpdateFields.parent;
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${subKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: cUpdateFields }) });
            createdIssues.push({ key: subKey });
          } else {
            const cRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: childFields }) });
            createdIssues.push({ key: (await cRes.json()).key });
          }
        }

        // 🌟 [핵심 추가] 기존보다 배너 개수가 줄어든 경우(특정 배너 편성 제외/삭제 시), 남은 기존 Sub-task에 [🚫편성제외/취소] 표시
        if (existingSubtasks.length > data.children.length) {
          for (let j = data.children.length; j < existingSubtasks.length; j++) {
            const orphanSub = existingSubtasks[j];
            const orphanKey = orphanSub.key;
            const prevSummary = orphanSub.fields?.summary || "배너 일감";
            const canceledSummary = prevSummary.startsWith("[🚫편성제외]") ? prevSummary : `[🚫편성제외] ${prevSummary}`;
            try {
              await deleteAllAttachments(baseUrl, orphanKey);
              await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${orphanKey}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
                credentials: 'include',
                body: JSON.stringify({
                  fields: {
                    summary: canceledSummary,
                    description: "<div style='padding:15px;background:#fff0f0;border:1px solid #ffccc7;border-radius:8px;color:#e74c3c;font-weight:bold;'>🚫 본 배너는 캠페인 기획 변경으로 인해 편성 제외(취소)되었습니다. 상위 캠페인 일감의 최신 종합표를 확인해 주세요.</div>"
                  }
                })
              });
            } catch (orphanErr) {
              console.warn(`⚠️ 제외된 하위 일감(${orphanKey}) 업데이트 실패:`, orphanErr.message);
            }
          }
        }
      } else {
        const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: parentFields }) });
        parentKey = (await parentRes.json()).key;
        await sleep(300);

        if (data.children && data.children.length > 0) {
          const childUpdates = data.children.map(child => {
            const safeChildDesc = child.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
            const fieldData = { project: { key: projectKey }, summary: child.title, description: safeChildDesc, issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey }, reporter: { name: targetUserId }, assignee: { name: child.assignee || targetUserId }, labels: (child.gnb || []).map(formatLabel) };
            if (child.startDate) fieldData[START_DATE_FIELD] = child.startDate;
            if (child.dueDate) fieldData[FINISH_DATE_FIELD] = child.dueDate;
            return { fields: fieldData };
          });
          const childBulkRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ issueUpdates: childUpdates }) });
          createdIssues = (await childBulkRes.json()).issues || [];
        }
      }

      // 🌟 [신규 보강] 상위 티켓에 GNB 담당자 멘션 및 기획 변경 안내 댓글(Comment) 자동 등록
      if (parentKey && data.parent.comment) {
        try {
          await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
            credentials: 'include',
            body: JSON.stringify({ body: data.parent.comment })
          });
        } catch (commentErr) {
          console.warn("⚠️ Jira 댓글 등록 실패:", commentErr.message);
        }
      }
    }

    // 🌟 2단계: 구글 시트 동기화 ('요청 접수' 시트에는 오직 배너 에셋 행만 깔끔하게 기록 + 담당자 '부서 / 이름' 포맷 적용)
    if (data.rawGasData) {
      const { meta, assignee, assets } = data.rawGasData;
      const uniqueCode = data.uniqueCode || meta.uniqueCode;
      const safeTargetSize = parseInt(String(meta.targetSize || '0').replace(/[^0-9]/g, ''), 10) || 0;
      const deptName = String(meta.department || 'Btv큐레이션팀').trim();
      const marketerName = String(meta.marketer || assignee || '').trim();
      const formattedAssignee = (deptName && marketerName && !marketerName.includes('/'))
        ? `${deptName} / ${marketerName}`
        : (marketerName || deptName);
      
      let bulkPayload = [];
      for (let i = 0; i < (assets || []).length; i++) {
        const asset = assets[i];
        const assetData = asset.data || {};
        const childJiraUrl = createdIssues[i] ? `${baseUrl}/browse/${createdIssues[i].key}` : (parentKey ? `${baseUrl}/browse/${parentKey}` : '');
        let textParts = [];
        if (assetData.topText) textParts.push(assetData.topText);
        if (assetData.mainTitle) textParts.push(assetData.mainTitle);
        if (assetData.bannerCopy) textParts.push(assetData.bannerCopy);
        if (assetData.subTitle) textParts.push(assetData.subTitle);

        bulkPayload.push({
          jiraLink: i === 0 && parentKey ? `${baseUrl}/browse/${parentKey}` : childJiraUrl,
          uniqueCode: uniqueCode,
          campaignName: meta.campaignName || '-',
          product: meta.product || '',
          targetType: meta.target || 'MASS',
          channel: Array.isArray(assetData.gnb) ? assetData.gnb.join(', ') : (assetData.gnb || '-'),
          hasBanner: "Y",
          taskType: asset.type || '-',
          startDate: assetData.startDate || meta.startDate || '',
          endDate: assetData.dueDate || meta.dueDate || '',
          assignee: formattedAssignee,
          targetSize: safeTargetSize,
          targetCondition: meta.targetCondition || '',
          notiChannel: '',
          mainCopy: textParts.length > 0 ? textParts.join(' / ') : (meta.conceptCopy || '-'),
          landingUrl: assetData.landingValue || '',
          designLink: assetData.imageUrl || assetData.bgImg || assetData.bannerImg || meta.mainImageUrl || '',
          hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
          // 첫 번째 배너 행의 U열에 전체 마스터 JSON(assets, mermaidCode, meta) 저장
          assets: i === 0 ? assets : undefined,
          mermaidCode: i === 0 ? (data.rawGasData.mermaidCode || "") : undefined,
          meta: i === 0 ? { ...meta, parentJiraKey: parentKey } : undefined
        });
      }
      
      if (bulkPayload.length > 0) {
        try {
          const dbRes = await fetch(CF_WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "bulkInsert", rows: bulkPayload }) });
          const dbText = await dbRes.text();
          let dbJson;
          try { dbJson = JSON.parse(dbText); } catch(e) {}
          
          if (!dbJson || dbJson.status !== "success") {
            if (sourceTabId) {
              chrome.scripting.executeScript({ 
                target: { tabId: sourceTabId }, 
                func: (msg) => alert("🚨 [구글 시트 저장 실패] 에러 상세 정보:\n" + msg), 
                args: [dbJson ? dbJson.message : dbText.substring(0, 150)] 
              }).catch(e=>e);
            }
          }
        } catch (dbErr) {
          if (sourceTabId) {
            chrome.scripting.executeScript({ 
              target: { tabId: sourceTabId }, 
              func: (msg) => alert("🚨 [구글 시트 통신 실패]\n" + msg), 
              args: [dbErr.message] 
            }).catch(e=>e);
          }
        }
      }
    }

    // 🌟 3단계: 사용자에게 생성/업데이트된 Jira 창을 즉시 오픈
    if (!data.skipJira && parentKey) {
      chrome.tabs.create({ url: `${baseUrl}/browse/${parentKey}` });
    }

    // 🌟 4단계: 첨부파일 업로드 및 본문 이미지 URL 치환
    if (!data.skipJira) {
      let uploadedParentAttachments = [];
      if (data.parent.images && data.parent.images.length > 0) {
        for (const imgObj of data.parent.images) {
          if (imgObj.dataUrl) {
            const formData = new FormData(); formData.append("file", dataURLtoBlob(imgObj.dataUrl), imgObj.filename);
            const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
            const attJson = await attachRes.json();
            uploadedParentAttachments.push(...attJson);
          }
        }
      }

      let mermaidAttachment = null;
      if (mermaidBlock) {
        try {
          const pngBlob = await mermaidToPngBlob(mermaidBlock.code);
          const mermaidFormData = new FormData();
          mermaidFormData.append("file", pngBlob, `user_flow_${Date.now()}.png`);
          const mermaidAttachRes = await fetchWithRetry(
            `${baseUrl}/rest/api/2/issue/${parentKey}/attachments`,
            { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: mermaidFormData }
          );
          const mermaidAttJson = await mermaidAttachRes.json();
          if (mermaidAttJson && mermaidAttJson.length > 0) mermaidAttachment = mermaidAttJson[0];
        } catch (mermaidErr) {
          console.warn("⚠️ 유저플로우 다이어그램 변환 실패:", mermaidErr.message);
        }
      }
    
      if (uploadedParentAttachments.length > 0 || mermaidAttachment || mermaidBlock) {
        let finalParentDesc = data.parent.desc;
        uploadedParentAttachments.forEach(att => {
          finalParentDesc = finalParentDesc.split(`PLACEHOLDER_${att.filename}`).join(att.content);
        });
        if (uploadedParentAttachments.length > 0) {
          finalParentDesc = finalParentDesc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, uploadedParentAttachments[0].content);
        }
        if (mermaidAttachment) {
          finalParentDesc = finalParentDesc.split(MERMAID_PLACEHOLDER).join(
            `<img src="${mermaidAttachment.content}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;" />`
          );
        } else if (mermaidBlock) {
          finalParentDesc = finalParentDesc.split(MERMAID_PLACEHOLDER).join(
            `<p style="color:#888;"><i>(유저플로우 다이어그램 렌더링 생략)</i></p>`
          );
        }
        await fetchWithRetry(
          `${baseUrl}/rest/api/2/issue/${parentKey}`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalParentDesc } }) }
        );
      }

      for (let i = 0; i < data.children.length; i++) {
        const childData = data.children[i];
        if (!createdIssues[i]) continue;
        const issueKey = createdIssues[i].key;

        if (childData.imageData) {
          const formData = new FormData(); formData.append("file", dataURLtoBlob(childData.imageData), "preview.png");
          const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
          const uploadedChildAtt = await attachRes.json();
          if (uploadedChildAtt && uploadedChildAtt.length > 0) {
            let finalChildDesc = childData.desc.split(`PLACEHOLDER_preview.png`).join(uploadedChildAtt[0].content).replace(/data:image\/[a-zA-Z0-9+;/=]+/g, uploadedChildAtt[0].content);
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalChildDesc } }) });
          }
        }
      }
    }
  } catch (error) {
    if (sourceTabId) chrome.scripting.executeScript({ target: { tabId: sourceTabId }, func: (errMsg) => alert("🚨 Jira 전송 에러 상세 정보:\n\n" + errMsg), args: [error.message] }).catch(e=>e);
  }
}
// 🌟 [신규 추가] 프로모션 삭제/취소 시 Jira 상위 티켓 및 하위 Sub-task 일괄 삭제(또는 취소 표기)
async function cancelOrDeleteJiraIssue(data) {
  const baseUrl = "https://jira.skbroadband.com";
  const rawKey = String(data.jiraKey || "").trim();
  if (!rawKey || rawKey === "-") return { status: "skipped", message: "연결된 Jira 키 없음" };

  // URL 형태("https://.../browse/BTVMKT-123")로 들어와도 순수 Key("BTVMKT-123")만 추출
  const issueKey = rawKey.split('/').pop().trim();
  if (!issueKey) return { status: "skipped" };

  // 1. 기존 이슈 정보 및 하위 일감(Sub-tasks) 목록 조회
  const pRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  const pData = await pRes.json();
  const subtasks = pData.fields?.subtasks || [];

  // 2. 1차 시도: Jira 이슈 완전 삭제 (deleteSubtasks=true 파라미터로 하위 일감까지 일괄 삭제 시도)
  try {
    const delRes = await fetch(`${baseUrl}/rest/api/2/issue/${issueKey}?deleteSubtasks=true`, {
      method: 'DELETE',
      headers: { 'X-Atlassian-Token': 'no-check' },
      credentials: 'include'
    });
    if (delRes.ok || delRes.status === 204) {
      return { status: "deleted", issueKey };
    }
  } catch (delErr) {
    console.warn(`⚠️ [${issueKey}] 직접 삭제 권한 없음, 취소 상태 표기로 전환합니다.`);
  }

  // 3. 2차 안전장치(Fallback): 사내 Jira 정책상 삭제(DELETE) 권한이 막혀있는 경우 -> 제목/본문을 [🚫프로모션취소]로 덮어쓰고 댓글 알림!
  await deleteAllAttachments(baseUrl, issueKey);
  const prevSummary = pData.fields?.summary || data.campaignName || "캠페인";
  const canceledSummary = prevSummary.startsWith("[🚫취소됨]") ? prevSummary : `[🚫취소됨] ${prevSummary}`;

  await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
    credentials: 'include',
    body: JSON.stringify({
      fields: {
        summary: canceledSummary,
        description: "<div style='padding:16px;background:#fff0f0;border:2px solid #ff4d4f;border-radius:8px;color:#cf1322;font-weight:bold;font-size:14px;'>🚫 본 캠페인 프로모션은 취소(삭제) 처리되어 모든 배너 편성 및 슬롯 예약이 해제되었습니다. 세팅을 진행하지 마세요.</div>"
      }
    })
  });

  // 하위 일감(Sub-task)들도 모두 [🚫취소됨]으로 일괄 변경
  for (const sub of subtasks) {
    try {
      await deleteAllAttachments(baseUrl, sub.key);
      const subSum = sub.fields?.summary || "배너 일감";
      await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${sub.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
        credentials: 'include',
        body: JSON.stringify({
          fields: {
            summary: subSum.startsWith("[🚫취소됨]") ? subSum : `[🚫취소됨] ${subSum}`,
            description: "<p style='color:#cf1322;font-weight:bold;'>🚫 상위 캠페인이 취소되어 본 배너 편성도 취소되었습니다.</p>"
          }
        })
      });
    } catch (e) {}
  }

  // 부모 티켓에 취소 안내 댓글 등록
  try {
    await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
      credentials: 'include',
      body: JSON.stringify({
        body: `🚫 [시스템 자동 알림] 본 프로모션(${data.campaignName || issueKey})이 어드민 대시보드에서 삭제(취소) 처리되었습니다. 배너 편성 및 세팅을 중단해 주세요.`
      })
    });
  } catch (e) {}

  return { status: "marked_canceled", issueKey };
}
