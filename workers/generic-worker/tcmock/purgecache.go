package tcmock

import (
	"testing"

	"github.com/taskcluster/taskcluster/v29/clients/client-go/tcpurgecache"
)

type PurgeCache struct {
}

/////////////////////////////////////////////////

func (purgeCache *PurgeCache) PurgeRequests(provisionerId, workerType, since string) (*tcpurgecache.OpenPurgeRequestList, error) {
	return &tcpurgecache.OpenPurgeRequestList{}, nil
}

/////////////////////////////////////////////////

func NewPurgeCache(t *testing.T) *PurgeCache {
	pc := &PurgeCache{}
	return pc
}
