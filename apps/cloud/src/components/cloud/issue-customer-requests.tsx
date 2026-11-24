"use client";

import { useCallback, useEffect, useState } from "react";
import { Select } from "@/components/ui/select";
import {
  requestChannelLabels,
  type CloudCustomer,
  type CustomerRequest,
} from "@/lib/cloud-customer-request-contract";
import { cloudRequest } from "./api-client";
import { useToast } from "./toast";

export function IssueCustomerRequests({
  issueId,
  writable,
}: {
  issueId: string;
  writable: boolean;
}) {
  const toast = useToast();
  const [requests, setRequests] = useState<CustomerRequest[]>([]);
  const [customers, setCustomers] = useState<CloudCustomer[]>([]);
  const load = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<{ requests: CustomerRequest[] }>(
        `customer-requests?issueId=${issueId}`,
        { signal },
      ).then((result) => {
        if (!signal?.aborted) setRequests(result.requests);
      }),
    [issueId],
  );
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal).catch(() => undefined);
    return () => abort.abort();
  }, [load]);
  useEffect(() => {
    if (!writable || !requests.length || customers.length) return;
    const abort = new AbortController();
    cloudRequest<{ customers: CloudCustomer[] }>("customers", {
      signal: abort.signal,
    })
      .then((result) => setCustomers(result.customers))
      .catch(() => undefined);
    return () => abort.abort();
  }, [writable, requests.length, customers.length]);
  if (!requests.length) return null;
  async function link(requestId: string, customerId: string | null) {
    try {
      await cloudRequest(`customer-requests/${requestId}`, {
        method: "PATCH",
        body: { customerId },
      });
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    }
  }
  return (
    <section className="cloud-aside-section" aria-label="Customer requests">
      <header>
        <h2>Customer requests · {requests.length}</h2>
      </header>
      <ul className="cloud-aside-requests">
        {requests.map((request) => (
          <li key={request.id}>
            {writable && customers.length > 0 ? (
              <Select
                aria-label={`Customer for ${request.title}`}
                value={request.customerId ?? ""}
                onChange={(event) =>
                  void link(request.id, event.target.value || null)
                }
              >
                <option value="">{request.requester || "Unknown"}</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </Select>
            ) : (
              <strong>
                {request.customerName ?? (request.requester || "Unknown")}
              </strong>
            )}
            <span>
              {requestChannelLabels[request.channel]}
              {request.mentions > 1 && ` · ${request.mentions}×`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
