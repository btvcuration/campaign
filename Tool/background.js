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

// 🌟 [1.9] 전송 진행 상황을 캠페인 매니저 탭에 알림 (content.js → window 'JIRA_SEND_PROGRESS')
//   화면이 이 이벤트를 처리하지 못하는 예전 버전이면(handled=false) 기존처럼 alert로 알림
function reportProgress(tabId, payload) {
  return new Promise((resolve) => {
    if (!tabId) return resolve(false);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'JIRA_SEND_PROGRESS', payload }, (res) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(Boolean(res && res.handled));
      });
    } catch (e) { resolve(false); }
  });
}
function alertInTab(tabId, msg) {
  if (!tabId) return;
  chrome.scripting.executeScript({ target: { tabId }, func: (m) => alert(m), args: [msg] }).catch(e => e);
}

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
  // 🌟 상위 일감 담당자(targetUserId)와 작성자/보고자(reporterUserId)를 명확히 분리!
  const targetUserId = data.parent?.assignee || "system";
  const reporterUserId = data.parent?.reporter || data.rawGasData?.assignee || targetUserId;
  const PARENT_ISSUE_TYPE = "Task", CHILD_ISSUE_TYPE = "Sub-Task";
  const START_DATE_FIELD = "customfield_10134", FINISH_DATE_FIELD = "customfield_10135";
  let parentKey = data.parentJiraKey || "";
  // 🌟 [1.9] children[i] ↔ assets[i] 순서 그대로 보관 (일부 실패해도 뒤 배너 링크가 밀리지 않게)
  const children = data.children || [];
  let createdIssues = new Array(children.length).fill(null);
  const failures = [];   // { step, name, message }
  const warnings = [];
  const childName = (c, i) => String(c?.assetName || c?.title || `배너 ${i + 1}`);
  const report = (payload) => reportProgress(sourceTabId, { uniqueCode: data.uniqueCode, ...payload });
  const createChild = async (fields) => {
    const r = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields }) });
    return { key: (await r.json()).key };
  };
  const isSessionError = (err) => String(err && err.message).includes('[401');

  try {
    // 🌟 1단계: Jira 상위 이슈 및 하위 Sub-task 생성/업데이트
    if (!data.skipJira) {
      const uniqueLabels = Array.from(new Set((data.children || []).flatMap(c => (c.gnb || []).map(formatLabel))));
      const safeInitialDesc = data.parent.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
      const parentFields = {
        project: { key: projectKey },
        summary: data.parent.title,
        description: safeInitialDesc,
        issuetype: { name: PARENT_ISSUE_TYPE },
        reporter: { name: reporterUserId }, // 🌟 보고자는 항상 작성자 본인
        assignee: { name: targetUserId },   // 🌟 담당자는 상위 일감 매체 담당자
        labels: uniqueLabels
      };
      if (data.parent.startDate) parentFields[START_DATE_FIELD] = data.parent.startDate;
      if (data.parent.dueDate) parentFields[FINISH_DATE_FIELD] = data.parent.dueDate;

      report({ stage: 'PARENT', parentKey, msg: parentKey ? `상위 일감 ${parentKey} 업데이트 중...` : '상위 일감 생성 중...' });
      if (parentKey) {
        const updateFields = { ...parentFields }; delete updateFields.project; delete updateFields.issuetype;
        await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: updateFields }) });
        await deleteAllAttachments(baseUrl, parentKey);
        const pRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
        const pData = await pRes.json();
        const existingSubtasks = pData.fields?.subtasks || [];

        const EXCLUDED_PREFIX = "[🚫편성제외]";
        const subSummary = (sub) => String(sub.fields?.summary || "");
        const assetNameOf = (c) => String(c.assetName || String(c.title || "").split(" _ ").pop() || "").trim();
        const usedSubKeys = new Set();
        const subtaskForChild = data.children.map(c => {
          const name = assetNameOf(c);
          const found = name && existingSubtasks.find(sub =>
            !usedSubKeys.has(sub.key) && subSummary(sub).replace(EXCLUDED_PREFIX, "").trim().endsWith(`_ ${name}`)
          );
          if (found) { usedSubKeys.add(found.key); return found; }
          return null;
        });
        data.children.forEach((c, i) => {
          if (subtaskForChild[i]) return;
          const spare = existingSubtasks.find(sub => !usedSubKeys.has(sub.key) && !subSummary(sub).startsWith(EXCLUDED_PREFIX));
          if (spare) { usedSubKeys.add(spare.key); subtaskForChild[i] = spare; }
        });

        for (let i = 0; i < data.children.length; i++) {
          const childData = data.children[i];
          const safeChildDesc = childData.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
          const childFields = {
            project: { key: projectKey }, summary: childData.title, description: safeChildDesc,
            issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey },
            reporter: { name: reporterUserId }, // 🌟 하위 일감 보고자도 작성자 본인
            assignee: { name: childData.assignee || targetUserId },
            labels: (childData.gnb || []).map(formatLabel)
          };
          if (childData.startDate) childFields[START_DATE_FIELD] = childData.startDate;
          if (childData.dueDate) childFields[FINISH_DATE_FIELD] = childData.dueDate;

          report({ stage: 'CHILDREN', done: i, total: data.children.length, parentKey, msg: `하위 일감 ${i + 1}/${data.children.length} 처리 중... (${childName(childData, i)})` });
          try {
            if (subtaskForChild[i]) {
              const subKey = subtaskForChild[i].key;
              await deleteAllAttachments(baseUrl, subKey);
              const cUpdateFields = { ...childFields }; delete cUpdateFields.project; delete cUpdateFields.issuetype; delete cUpdateFields.parent;
              await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${subKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: cUpdateFields }) });
              createdIssues[i] = { key: subKey };
            } else {
              createdIssues[i] = await createChild(childFields);
            }
          } catch (childErr) {
            if (isSessionError(childErr)) throw childErr; // 세션 만료는 전체 중단
            failures.push({ step: '하위 일감', name: childName(childData, i), message: childErr.message });
          }
        }

        const orphanSubtasks = existingSubtasks.filter(sub => !usedSubKeys.has(sub.key) && !subSummary(sub).startsWith(EXCLUDED_PREFIX));
        if (orphanSubtasks.length > 0) {
          for (const orphanSub of orphanSubtasks) {
            const orphanKey = orphanSub.key;
            const prevSummary = orphanSub.fields?.summary || "배너 일감";
            const canceledSummary = prevSummary.startsWith(EXCLUDED_PREFIX) ? prevSummary : `${EXCLUDED_PREFIX} ${prevSummary}`;
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
        // 상위 일감이 만들어지면 키를 바로 알려 둠 → 이후 실패해도 재전송 시 상위 일감이 또 생기지 않음
        report({ stage: 'PARENT_CREATED', parentKey, msg: `상위 일감 ${parentKey} 생성 완료` });
        await sleep(300);

        if (data.children && data.children.length > 0) {
          const childUpdates = data.children.map(child => {
            const safeChildDesc = child.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
            const fieldData = {
              project: { key: projectKey }, summary: child.title, description: safeChildDesc,
              issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey },
              reporter: { name: reporterUserId }, // 🌟 하위 일감 보고자도 작성자 본인
              assignee: { name: child.assignee || targetUserId },
              labels: (child.gnb || []).map(formatLabel)
            };
            if (child.startDate) fieldData[START_DATE_FIELD] = child.startDate;
            if (child.dueDate) fieldData[FINISH_DATE_FIELD] = child.dueDate;
            return { fields: fieldData };
          });
          report({ stage: 'CHILDREN', done: 0, total: childUpdates.length, parentKey, msg: `하위 일감 ${childUpdates.length}건 생성 중...` });
          let bulkJson = {};
          try {
            const childBulkRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ issueUpdates: childUpdates }) });
            bulkJson = await childBulkRes.json();
          } catch (bulkErr) {
            if (isSessionError(bulkErr)) throw bulkErr;
            bulkJson = { issues: [], errors: childUpdates.map((_, i) => ({ failedElementNumber: i })) };
          }
          // bulk 응답의 issues는 '성공한 것만' 순서대로 옴 → 실패 번호를 건너뛰며 배너 순서에 맞춰 배치
          const failedIdx = new Set((bulkJson.errors || []).map(e => Number(e.failedElementNumber)));
          const okIssues = bulkJson.issues || [];
          let k = 0;
          for (let i = 0; i < childUpdates.length; i++) {
            if (failedIdx.has(i)) continue;
            if (okIssues[k]) createdIssues[i] = { key: okIssues[k].key };
            k++;
          }
          // 실패한 건은 한 번씩 개별 생성으로 재시도
          for (let i = 0; i < childUpdates.length; i++) {
            if (createdIssues[i]) continue;
            report({ stage: 'CHILDREN', done: i, total: childUpdates.length, parentKey, msg: `하위 일감 재시도 중... (${childName(children[i], i)})` });
            try {
              createdIssues[i] = await createChild(childUpdates[i].fields);
            } catch (retryErr) {
              if (isSessionError(retryErr)) throw retryErr;
              failures.push({ step: '하위 일감', name: childName(children[i], i), message: retryErr.message });
            }
          }
        }
      }

      if (parentKey && data.parent.comment && !data.skipComment) {
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

    // 🌟 2단계: 구글 시트 동기화
    let sheetOk = true, sheetMessage = '';
    if (data.rawGasData) {
      report({ stage: 'SHEET', parentKey, msg: '구글 시트 기록 중...' });
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
            sheetOk = false;
            sheetMessage = "[구글 시트 저장 실패] " + (dbJson ? dbJson.message : dbText.substring(0, 150));
          }
        } catch (dbErr) {
          sheetOk = false;
          sheetMessage = "[구글 시트 통신 실패] " + dbErr.message;
        }
        if (!sheetOk) failures.push({ step: '구글 시트', name: '요청 접수·스케줄', message: sheetMessage });
      }
    }

    // 🌟 4단계: 첨부파일 업로드 및 본문 이미지 URL 치환
    if (!data.skipJira) {
      report({ stage: 'ATTACH', done: 0, total: children.length, parentKey, msg: '시안 이미지 첨부 중...' });
      let uploadedParentAttachments = [];
      if (data.parent.images && data.parent.images.length > 0) {
        for (const imgObj of data.parent.images) {
          if (imgObj.dataUrl) {
            try {
              const formData = new FormData(); formData.append("file", dataURLtoBlob(imgObj.dataUrl), imgObj.filename);
              const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
              const attJson = await attachRes.json();
              uploadedParentAttachments.push(...attJson);
            } catch (attErr) {
              if (isSessionError(attErr)) throw attErr;
              warnings.push(`상위 일감 첨부(${imgObj.filename}) 실패: ${attErr.message}`);
            }
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
        try {
          await fetchWithRetry(
            `${baseUrl}/rest/api/2/issue/${parentKey}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalParentDesc } }) }
          );
        } catch (descErr) {
          if (isSessionError(descErr)) throw descErr;
          warnings.push(`상위 일감 본문 이미지 반영 실패: ${descErr.message}`);
        }
      }

      for (let i = 0; i < data.children.length; i++) {
        const childData = data.children[i];
        if (!createdIssues[i]) continue;
        const issueKey = createdIssues[i].key;
        report({ stage: 'ATTACH', done: i, total: data.children.length, parentKey, msg: `시안 이미지 첨부 ${i + 1}/${data.children.length}...` });

        if (childData.imageData) {
          try {
            const formData = new FormData(); formData.append("file", dataURLtoBlob(childData.imageData), "preview.png");
            const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
            const uploadedChildAtt = await attachRes.json();
            if (uploadedChildAtt && uploadedChildAtt.length > 0) {
              let finalChildDesc = childData.desc.split(`PLACEHOLDER_preview.png`).join(uploadedChildAtt[0].content).replace(/data:image\/[a-zA-Z0-9+;/=]+/g, uploadedChildAtt[0].content);
              await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalChildDesc } }) });
            }
          } catch (attErr) {
            if (isSessionError(attErr)) throw attErr;
            warnings.push(`${issueKey} 시안 이미지 첨부 실패: ${attErr.message}`);
          }
        }
      }
    }

    // 🌟 3단계: 결과 알림 후 Jira 창 열기 (첨부까지 끝난 뒤에 열어야 본문 이미지가 보임)
    const handled = await report({
      stage: failures.length > 0 ? 'PARTIAL' : 'DONE',
      parentKey,
      children: children.map((c, i) => ({ assetId: c.assetId || '', name: childName(c, i), key: createdIssues[i]?.key || '' })),
      failures, warnings, sheetOk
    });
    if (!handled && failures.length > 0) {
      alertInTab(sourceTabId, "🚨 Jira 전송 중 일부 실패:\n\n" + failures.map(f => `- [${f.step}] ${f.name}: ${f.message}`).join('\n'));
    }
    if (!data.skipJira && parentKey) {
      chrome.tabs.create({ url: `${baseUrl}/browse/${parentKey}` });
    }
  } catch (error) {
    // 상위 일감 키(있으면)를 함께 알려서, 재전송 시 새 일감을 만들지 않고 이어서 처리하게 함
    const handled = await report({
      stage: 'ERROR', parentKey, message: error.message,
      children: children.map((c, i) => ({ assetId: c.assetId || '', name: childName(c, i), key: createdIssues[i]?.key || '' })),
      failures
    });
    if (!handled) alertInTab(sourceTabId, "🚨 Jira 전송 에러 상세 정보:\n\n" + error.message);
  }
}

async function cancelOrDeleteJiraIssue(data) {
  const baseUrl = "https://jira.skbroadband.com";
  const rawKey = String(data.jiraKey || "").trim();
  if (!rawKey || rawKey === "-") return { status: "skipped", message: "연결된 Jira 키 없음" };

  const issueKey = rawKey.split('/').pop().trim();
  if (!issueKey) return { status: "skipped" };

  const pRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  const pData = await pRes.json();
  const subtasks = pData.fields?.subtasks || [];

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
