package store

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// OnServiceCreated triggers async side-effects when a Service node is added to the store.
// Currently: LoadBalancer-type services receive a simulated external IP after a provisioning delay.
func OnServiceCreated(s *ClusterStore, svc *models.Node) {
	if svc.Kind != models.KindService {
		return
	}
	var spec models.ServiceSpec
	if err := json.Unmarshal(svc.Spec, &spec); err != nil {
		return
	}
	if spec.Type != models.ServiceLoadBalancer {
		return
	}
	go assignLoadBalancerIP(s, svc.ID)
}

// assignLoadBalancerIP simulates a cloud controller manager assigning an
// external IP to a LoadBalancer Service. Uses TEST-NET-3 (203.0.113.0/24)
// so it's clearly a simulation and won't conflict with real routing.
func assignLoadBalancerIP(s *ClusterStore, svcID string) {
	// Cloud providers typically take 15-60 seconds; we compress to 4-8s.
	delay := time.Duration(4+rand.Intn(5)) * time.Second
	time.Sleep(delay)

	svc, ok := s.Get(svcID)
	if !ok {
		return // Service was deleted before provisioning completed
	}

	ip := fmt.Sprintf("203.0.113.%d", 10+rand.Intn(240))

	if svc.Annotations == nil {
		svc.Annotations = make(map[string]string)
	}
	svc.Annotations["k8svisualizer/external-ip"] = ip
	svc.Annotations["k8svisualizer/lb-provisioned"] = time.Now().Format(time.RFC3339)

	svc.Status, _ = json.Marshal(map[string]any{
		"loadBalancer": map[string]any{
			"ingress": []map[string]string{
				{"ip": ip},
			},
		},
	})
	s.Update(svc)
}
