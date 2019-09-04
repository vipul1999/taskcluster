package standalone

import (
	"github.com/taskcluster/taskcluster-worker-runner/cfg"
	"github.com/taskcluster/taskcluster-worker-runner/protocol"
	"github.com/taskcluster/taskcluster-worker-runner/provider/provider"
	"github.com/taskcluster/taskcluster-worker-runner/run"
)

type standaloneProviderConfig struct {
	RootURL      string
	ClientID     string
	AccessToken  string
	WorkerPoolID string
	WorkerGroup  string
	WorkerID     string
}

type StandaloneProvider struct {
	runnercfg *cfg.RunnerConfig
}

func (p *StandaloneProvider) ConfigureRun(state *run.State) error {
	var pc standaloneProviderConfig
	err := p.runnercfg.Provider.Unpack(&pc)
	if err != nil {
		return err
	}

	state.RootURL = pc.RootURL
	state.Credentials.ClientID = pc.ClientID
	state.Credentials.AccessToken = pc.AccessToken
	state.WorkerPoolID = pc.WorkerPoolID
	state.WorkerGroup = pc.WorkerGroup
	state.WorkerID = pc.WorkerID
	state.WorkerLocation = map[string]string{
		"cloud": "standalone",
	}

	state.ProviderMetadata = map[string]string{}

	if workerLocation, ok := p.runnercfg.Provider.Data["workerLocation"]; ok {
		for k, v := range workerLocation.(map[string]string) {
			state.WorkerLocation[k] = v
		}
	}

	return nil
}

func (p *StandaloneProvider) UseCachedRun(run *run.State) error {
	return nil
}

func (p *StandaloneProvider) SetProtocol(proto *protocol.Protocol) {
}

func (p *StandaloneProvider) WorkerStarted() error {
	return nil
}

func (p *StandaloneProvider) WorkerFinished() error {
	return nil
}

func New(runnercfg *cfg.RunnerConfig) (provider.Provider, error) {
	return &StandaloneProvider{runnercfg}, nil
}

func Usage() string {
	return `
The providerType "standalone" is intended for workers that have all of their
configuration pre-loaded.  Such workers do not interact with the worker manager.
This is not a recommended configuration - prefer to use the static provider.

It requires the following properties be included explicitly in the runner
configuration:

` + "```yaml" + `
provider:
    providerType: standalone
    rootURL: ..  # note the Golang spelling with capitalized "URL"
    clientID: .. # ..and similarly capitalized ID
    accessToken: ..
    workerPoolID: ..
    workerGroup: ..
    workerID: ..
    # custom properties for TASKCLUSTER_WORKER_LOCATION
    workerLocation:  {prop: val, ..}
` + "```" + `

The TASKCLUSTER_WORKER_LOCATION of this provider has the following fields:

* cloud: standalone

as well as any worker location values from the configuration.
`
}
