export const issueSubscribedClause = `COALESCE(
  (SELECT s.subscribed FROM cloud_issue_subscriptions s WHERE s.organization_id=i.organization_id AND s.issue_id=i.id AND s.user_id=u.id),
  u.id=i.assignee_id
  OR EXISTS (SELECT 1 FROM cloud_issue_history h WHERE h.organization_id=i.organization_id AND h.issue_id=i.id AND h.revision=1 AND h.actor_id=u.id)
  OR EXISTS (SELECT 1 FROM cloud_comments c WHERE c.organization_id=i.organization_id AND c.issue_id=i.id AND c.author_id=u.id AND NOT c.deleted)
)`;
