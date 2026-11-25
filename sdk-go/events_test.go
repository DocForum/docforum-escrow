package escrow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestGetEventsPaging verifies that GetEvents sends a well-formed getEvents
// JSON-RPC request (contract filter, cursor, limit) and returns the page
// cursor and latest ledger. The RPC is mocked with an httptest server.
func TestGetEventsPaging(t *testing.T) {
	var gotReq struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			StartLedger uint32 `json:"startLedger"`
			Filters     []struct {
				ContractIDs []string `json:"contractIds"`
			} `json:"filters"`
			Pagination struct {
				Cursor string `json:"cursor"`
				Limit  int    `json:"limit"`
			} `json:"pagination"`
		} `json:"params"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      gotReq.ID,
			"result": map[string]any{
				"events":       []any{},
				"latestLedger": float64(42),
				"cursor":       "next-page-cursor",
			},
		}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	}))
	defer srv.Close()

	client, err := New(Config{
		RPCURL:            srv.URL,
		HTTPClient:        srv.Client(),
		ContractID:        testContractID,
		NetworkPassphrase: "Test SDF Network ; September 2015",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	res, err := client.GetEvents(context.Background(), EventsQuery{
		ContractID: testContractID,
		Cursor:     "0000000000000000001-0000000001",
		Limit:      7,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Cursor != "next-page-cursor" {
		t.Fatalf("cursor = %q, want %q", res.Cursor, "next-page-cursor")
	}
	if res.LatestLedger != 42 {
		t.Fatalf("latestLedger = %d, want 42", res.LatestLedger)
	}
	if len(res.Events) != 0 {
		t.Fatalf("expected no events, got %d", len(res.Events))
	}
	if gotReq.Method != "getEvents" {
		t.Fatalf("method = %q, want getEvents", gotReq.Method)
	}
	if len(gotReq.Params.Filters) != 1 || len(gotReq.Params.Filters[0].ContractIDs) != 1 ||
		gotReq.Params.Filters[0].ContractIDs[0] != testContractID {
		t.Fatalf("filters = %+v, want one filter with contract %s", gotReq.Params.Filters, testContractID)
	}
	if gotReq.Params.Pagination.Cursor != "0000000000000000001-0000000001" {
		t.Fatalf("pagination.cursor = %q", gotReq.Params.Pagination.Cursor)
	}
	if gotReq.Params.Pagination.Limit != 7 {
		t.Fatalf("pagination.limit = %d, want 7", gotReq.Params.Pagination.Limit)
	}
	if gotReq.Params.StartLedger != 0 {
		t.Fatalf("startLedger = %d, want 0 when a cursor is set", gotReq.Params.StartLedger)
	}
}
