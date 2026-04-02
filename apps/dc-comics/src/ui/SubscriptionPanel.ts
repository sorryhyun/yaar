import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { openSubDetail, closeSubDetail, refreshAllSubs, unsubscribeSeries, selectPost } from '../actions';
import type { Subscription, SeriesPost } from '../types';

function SubDetail() {
  const sub = () => state.selectedSub!;
  return html`
    <div class="sub-detail">
      <div class="sub-detail-header">
        <button class="y-btn y-btn-ghost" onclick=${closeSubDetail}>←</button>
        <span class="sub-detail-title">${() => sub().title}</span>
      </div>
      <div class="sub-detail-posts">
        ${() => sub().latestPosts.length === 0
          ? html`<div class="comment-empty">글이 없습니다.</div>`
          : null}
        <${For} each=${() => sub().latestPosts}>
          ${(post: SeriesPost) => html`
            <button
              class=${() => post.isNew ? 'sub-post-item series-new' : 'sub-post-item'}
              onclick=${() => {
                setState({ activePanel: 'feed' });
                const gallId = sub().gallId;
                const url = `https://m.dcinside.com/board/${gallId}/${post.id}`;
                const fakePost = {
                  id: `post-${post.id}`,
                  num: post.id,
                  title: post.title,
                  url,
                  author: '',
                  date: post.date,
                  views: '0',
                  recommend: '0',
                  comments: '0',
                  isNotice: false,
                  hasImage: false,
                };
                selectPost(fakePost);
              }}
            >
              <span class="sub-post-title">${() => post.title}</span>
              <span class="sub-post-date">${() => post.date}</span>
            </button>
          `}
        </>
      </div>
    </div>
  `;
}

function SubItem(props: { sub: Subscription }) {
  return html`
    <div class="sub-item" onclick=${() => openSubDetail(props.sub)}>
      <div class="sub-item-info">
        <span class="sub-item-title">${() => props.sub.title}</span>
        ${() => props.sub.unreadCount > 0
          ? html`<span class="unread-badge">${() => props.sub.unreadCount}</span>`
          : null}
      </div>
      <div class="sub-item-meta">
        <span>${() => props.sub.gallId}</span>
        <button
          class="subscribe-btn subscribe-btn-active"
          onclick=${(e: Event) => {
            e.stopPropagation();
            if (confirm(`'${props.sub.title}' 구독을 취소하시겠습니까?`)) {
              unsubscribeSeries(props.sub.id);
            }
          }}
        >구독 중 ✓</button>
      </div>
    </div>
  `;
}

export function SubscriptionPanel() {
  return html`
    <div class="sub-panel">
      ${() => state.selectedSub
        ? html`<${SubDetail} />`
        : html`
          <div class="sub-panel-toolbar">
            <span class="y-label">구독 중인 시리즈</span>
            <button
              class="y-btn y-btn-ghost"
              onclick=${refreshAllSubs}
            >갱신</button>
          </div>
          ${() => state.subscriptions.length === 0
            ? html`
              <div class="y-empty">
                <div class="y-empty-icon">📢</div>
                <p>시리즈 구독 없음</p>
                <p style="font-size:12px;margin-top:4px">글 상세 보기에서 + 구독 버튜을 눌러주세요</p>
              </div>`
            : null}
          <div class="sub-list">
            <${For} each=${() => state.subscriptions}>
              ${(sub: Subscription) => html`<${SubItem} sub=${sub} />`}
            </>
          </div>
        `}
    </div>
  `;
}