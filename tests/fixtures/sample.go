package main

import "fmt"

type Sample struct {
	count int
}

func (s *Sample) Get() int {
	return s.count
}

func Run(items []string) {
	for _, it := range items {
		fmt.Println(it)
	}
}
